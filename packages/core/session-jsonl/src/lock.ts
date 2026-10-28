import type { SessionError, SessionId } from '@jozo-harness/session'
import { Effect } from 'effect'
import { unlinkSync } from 'node:fs'
import { open, readFile, unlink } from 'node:fs/promises'
import { persistenceError } from './errors.ts'

/** Suffix of the file that marks a log as being written; the log itself never holds it. */
export const LOCK_SUFFIX = '.lock'

/** The lock that guards one log. */
export interface SessionLock {
  readonly path: string
  /** Removes the lock if this holder still owns it. Safe to call twice. */
  readonly release: Effect.Effect<void>
}

/** What a lock records: who holds the log, and since when. */
interface LockRecord {
  readonly pid: number
  readonly start: number
  readonly token: string
}

interface HeldLock {
  readonly record: LockRecord
  holders: number
}

/**
 * Locks this process holds, keyed by path. Two sessions in one process may name
 * the same log (a seeded create reopens what it just wrote), and appends from one
 * event loop never interleave, so the lock counts holders instead of refusing them.
 * Another process still sees the file and is turned away.
 */
const registry = new Map<string, HeldLock>()
let exitArmed = false

const recordOf = (text: string): LockRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { pid, start, token } = parsed as Record<string, unknown>
    return typeof pid === 'number' &&
      Number.isInteger(pid) &&
      pid > 0 &&
      typeof start === 'number' &&
      typeof token === 'string'
      ? { pid, start, token }
      : undefined
  } catch {
    return undefined
  }
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined

/**
 * Whether a process with this pid exists. Signal 0 only asks whether the process
 * is reachable. This holds on one machine only: a pid recorded on another host
 * says nothing about whether that writer is alive, so a lock shared across
 * machines over a network filesystem must not be trusted.
 */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM still means the process exists, it just belongs to another user.
    return codeOf(error) === 'EPERM'
  }
}

const held = (id: SessionId, path: string): SessionError =>
  persistenceError('session ' + id + ' is being written by another process (lock ' + path + ')')

/**
 * Drops every lock this process holds. A process that ends normally or throws
 * runs this from the exit hook; a kill that skips the hook leaves the files
 * behind, and the next writer reads the dead pid and repairs the tail.
 */
export const releaseAllLocks = (): void => {
  for (const path of registry.keys()) {
    try {
      unlinkSync(path)
    } catch {
      // The lock is gone already; nothing to clean up.
    }
  }
  registry.clear()
}

const armExit = (): void => {
  if (exitArmed) return
  exitArmed = true
  process.once('exit', releaseAllLocks)
}

const releaseOf = (path: string, record: LockRecord): Effect.Effect<void> =>
  Effect.promise(async () => {
    const shared = registry.get(path)
    if (shared !== undefined && shared.record.token === record.token) {
      shared.holders -= 1
      if (shared.holders > 0) return
      registry.delete(path)
    }
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      // The lock is gone already.
    }
    // A lock another process took over names its own token: removing it would
    // hand the log to two writers at once.
    if (recordOf(text)?.token !== record.token) return
    try {
      await unlink(path)
    } catch {
      // Another holder removed it first; the log is no longer ours either way.
    }
  })

const createLock = async (path: string): Promise<LockRecord> => {
  const handle = await open(path, 'wx')
  const record: LockRecord = { pid: process.pid, start: Date.now(), token: crypto.randomUUID() }
  try {
    await handle.writeFile(JSON.stringify(record))
    await handle.sync()
  } catch (error) {
    await handle.close()
    try {
      await unlink(path)
    } catch {
      // Nothing was written, so there is nothing to clean up.
    }
    throw error
  }
  await handle.close()
  return record
}

/** Creates the lock, or reports EEXIST as no record so the caller can look at the holder. */
const tryCreateLock = async (path: string): Promise<LockRecord | undefined> => {
  try {
    return await createLock(path)
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return undefined
    throw error
  }
}

/** Whether the lock's holder is gone, including one that died writing its record. */
const staleAt = async (path: string): Promise<boolean> => {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // The holder removed its lock between our create and this read.
  }
  const record = recordOf(text)
  return record === undefined || !isProcessAlive(record.pid)
}

/** Registers a fresh lock as this process's, and hands out the first holder. */
const registerLock = (path: string, record: LockRecord): SessionLock => {
  registry.set(path, { record, holders: 1 })
  armExit()
  return { path, release: releaseOf(path, record) }
}

/** Removes a lock whose holder is gone; a contender may have removed it already. */
const dropStale = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch {
    // The other contender removed the stale lock first.
  }
}

const takeLock = async (logPath: string, id: SessionId): Promise<SessionLock> => {
  const path = logPath + LOCK_SUFFIX
  const shared = registry.get(path)
  if (shared !== undefined) {
    shared.holders += 1
    return { path, release: releaseOf(path, shared.record) }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = await tryCreateLock(path)
    if (record !== undefined) return registerLock(path, record)
    if (!(await staleAt(path))) throw held(id, path)
    // Both contenders unlink; the one that creates second reads a live lock next round.
    await dropStale(path)
  }
  throw held(id, path)
}

/**
 * Takes the write lock beside a log, or fails when a live process holds it.
 * A lock whose pid is gone is stale: its writer crashed, so the next writer
 * takes it over and repairs whatever tail the crash left.
 */
export const acquireLock = (
  logPath: string,
  id: SessionId,
): Effect.Effect<SessionLock, SessionError> =>
  Effect.tryPromise({
    try: () => takeLock(logPath, id),
    catch: (cause) =>
      cause instanceof Error && cause.name === 'SessionError'
        ? (cause as SessionError)
        : persistenceError('cannot lock session ' + id, cause),
  })
