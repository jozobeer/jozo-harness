import type { SessionError, SessionId } from '@jozo-harness/session'
import { Effect } from 'effect'
import { readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { link, open, readFile, unlink } from 'node:fs/promises'
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
  for (const [path, heldLock] of registry) {
    try {
      const text = readFileSync(path, 'utf8')
      // A successor already published its own record under this name. Unlinking
      // it would drop the only thing keeping a third process out.
      if (recordOf(text)?.token !== heldLock.record.token) continue
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

/** Registers a fresh lock as this process's, and hands out the first holder. */
const registerLock = (path: string, record: LockRecord): SessionLock => {
  registry.set(path, { record, holders: 1 })
  armExit()
  return { path, release: releaseOf(path, record) }
}

/**
 * How many times to publish or step aside before giving up. Each attempt is a
 * few filesystem calls; the bound only stops a livelock if graves never drain.
 */
const STEAL_ATTEMPTS = 8

/**
 * Widens the publish and steal gaps when a test sets this. Production leaves
 * it unset, so a real acquire does not wait. The double-take only shows up
 * when one process publishes in the gap after another has decided the lock is stale.
 */
const raceGap = async (): Promise<void> => {
  const raw = process.env.JZH_LOCK_RACE_DELAY_MS
  if (raw === undefined || raw === '') return
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Sibling files that hold a lock moved aside so its holder can be re-read. */
const gravesOf = (path: string): ReadonlyArray<string> => {
  const slash = path.lastIndexOf('/')
  const dir = slash < 0 ? '.' : path.slice(0, slash)
  const prefix = path.slice(slash + 1) + '.grave.'
  let names: ReadonlyArray<string> = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found: string[] = []
  for (const name of names) {
    if (name.startsWith(prefix)) found.push(dir + '/' + name)
  }
  return found
}

const readRecord = (path: string): LockRecord | undefined => {
  try {
    return recordOf(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The lock file's bytes, or undefined when the name is absent. */
const fileText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Puts a moved lock back under its real name. A failure means another writer
 * already published there; the grave stays so that writer can drop its own
 * record and try this one again.
 */
const restoreGrave = (grave: string, path: string): void => {
  try {
    renameSync(grave, path)
  } catch {
    // The lock name is occupied.
  }
}

const dropGrave = (grave: string): void => {
  try {
    unlinkSync(grave)
  } catch {
    // A contender removed the grave first.
  }
}

/** A crashed stealer leaves graves behind. A live one goes back; a dead one is dropped. */
const recoverGraves = (path: string): void => {
  for (const grave of gravesOf(path)) {
    const record = readRecord(grave)
    if (record !== undefined && isProcessAlive(record.pid)) {
      restoreGrave(grave, path)
      continue
    }
    dropGrave(grave)
  }
}

/**
 * Links a durable record under the lock name. The name appears only after the
 * bytes are synced, so a reader never sees an empty file and treats it as a
 * dead holder.
 */
const publish = async (path: string, record: LockRecord): Promise<void> => {
  const temporary = path + '.' + record.token + '.tmp'
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(JSON.stringify(record))
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  await handle.close()
  await raceGap()
  try {
    await link(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** A grave names some other process that is still running. */
const isForeignLive = (record: LockRecord | undefined): boolean =>
  record !== undefined && isProcessAlive(record.pid) && record.pid !== process.pid

/** Removes the lock name only while it still carries the record we published. */
const dropIfToken = (path: string, token: string): void => {
  if (readRecord(path)?.token !== token) return
  try {
    unlinkSync(path)
  } catch {
    // The name already moved.
  }
}

/**
 * Drops the lock we just published when a grave names another live writer, and
 * puts that writer back. Returns whether this attempt gave the name up.
 */
const yieldToLiveGrave = (path: string, token: string): boolean => {
  for (const grave of gravesOf(path)) {
    if (!isForeignLive(readRecord(grave))) {
      dropGrave(grave)
      continue
    }
    // The bytes under the name may already belong to a writer that published
    // after we linked. Only the record we just wrote may be removed.
    dropIfToken(path, token)
    restoreGrave(grave, path)
    return true
  }
  return false
}

/** Creates the lock, or reports nothing when the name is taken or a grave must win. */
const tryCreateLock = async (path: string): Promise<LockRecord | undefined> => {
  // Publishing while a grave exists would put a second writer beside the
  // record someone moved aside to re-read.
  if (gravesOf(path).length > 0) return undefined
  const record: LockRecord = { pid: process.pid, start: Date.now(), token: crypto.randomUUID() }
  try {
    await publish(path, record)
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return undefined
    throw error
  }
  await raceGap()
  if (yieldToLiveGrave(path, record.token)) return undefined
  return readRecord(path)?.token === record.token ? record : undefined
}

/**
 * Moves the lock aside and reads that inode. Unlinking the name instead can
 * delete a live record a contender linked after our stale snapshot. Returns
 * whether the moved holder is still alive (and has been put back).
 */
const moveAside = async (path: string): Promise<boolean> => {
  const grave = path + '.grave.' + crypto.randomUUID()
  try {
    renameSync(path, grave)
  } catch {
    return false
  }
  await raceGap()
  const moved = readRecord(grave)
  if (moved !== undefined && isProcessAlive(moved.pid)) {
    restoreGrave(grave, path)
    return true
  }
  try {
    unlinkSync(grave)
  } catch {
    // Already gone.
  }
  return false
}

const holderIsAlive = (text: string): boolean => {
  const holder = recordOf(text)
  return holder !== undefined && isProcessAlive(holder.pid)
}

/** One publish or one step-aside. Undefined means try again; a live holder throws. */
const stealOnce = async (path: string, id: SessionId): Promise<SessionLock | undefined> => {
  recoverGraves(path)
  const created = await tryCreateLock(path)
  if (created !== undefined) return registerLock(path, created)
  const text = fileText(path)
  if (text === undefined) return undefined
  if (holderIsAlive(text)) throw held(id, path)
  if (await moveAside(path)) throw held(id, path)
  return undefined
}

const takeLock = async (logPath: string, id: SessionId): Promise<SessionLock> => {
  const path = logPath + LOCK_SUFFIX
  const shared = registry.get(path)
  if (shared !== undefined) {
    shared.holders += 1
    return { path, release: releaseOf(path, shared.record) }
  }
  for (let attempt = 0; attempt < STEAL_ATTEMPTS; attempt += 1) {
    const taken = await stealOnce(path, id)
    if (taken !== undefined) return taken
  }
  throw held(id, path)
}

/**
 * Takes the write lock beside a log, or fails when a live process holds it.
 * A lock whose pid is gone is stale: its writer crashed, so the next writer
 * takes it over and repairs whatever tail the crash left. Takeover renames the
 * lock aside and reads that inode again; unlinking the name would also delete
 * a record a contender published after the stale snapshot, and both would append.
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
