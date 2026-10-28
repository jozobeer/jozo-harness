import { afterAll, describe, expect, test } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@jozo-harness/session'
import {
  acquireLock,
  encodeZstdFrame,
  jsonlSessions,
  releaseAllLocks,
  LOCK_SUFFIX,
  makeSessionQuery,
  SESSION_ZSTD_FILE_NAME,
  splitZstdLog,
} from '../src/index.ts'

const tempRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-lock-'))

const isolated = () => {
  const root = join(tempRoot, crypto.randomUUID())
  return { root, persistence: jsonlSessions({ root }) }
}

const headerEvent: SessionEvent = {
  seq: 1,
  time: 100,
  type: 'session/header',
  data: { formatVersion: SESSION_FORMAT_VERSION, createdAt: 100, cwd: '/work' },
}

const fileOf = (root: string, id: string): string => join(root, id, SESSION_ZSTD_FILE_NAME)
const lockOf = (root: string, id: string): string => fileOf(root, id) + LOCK_SUFFIX

/** Writes a log with its header, plus whatever tail a crash left after it. */
const seedLog = async (
  root: string,
  id: string,
  tail: Uint8Array = new Uint8Array(),
): Promise<void> => {
  await mkdir(join(root, id), { recursive: true })
  const header = encodeZstdFrame(JSON.stringify(headerEvent) + '\n')
  await writeFile(fileOf(root, id), Buffer.concat([header, tail]))
}

const hold = async (path: string, pid: number, token = 'other'): Promise<void> => {
  await writeFile(path, JSON.stringify({ pid, start: Date.now(), token }))
}

/** A pid no process holds: a child that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid ?? 0

const waitForHeld = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve, reject) => {
    child.stdout?.once('data', () => resolve())
    child.once('error', reject)
  })

const exited = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve) => child.once('exit', () => resolve()))

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('the session log lock', () => {
  test('a second process is refused while the first holds the log, and the lock goes at exit', async () => {
    const { root, persistence } = isolated()
    const id = 'shared'
    await seedLog(root, id)

    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, 'lock-holder.ts'), fileOf(root, id)],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    )
    try {
      await waitForHeld(child)
      const holder = JSON.parse(await readFile(lockOf(root, id), 'utf8')) as { pid: number }
      expect(holder.pid).toBe(child.pid)

      const error = await Effect.runPromise(Effect.flip(persistence.open(id)))
      expect(error.code).toBe('persistence')
      expect(error.message).toContain('being written by another process')
    } finally {
      child.stdin?.end('go')
      await exited(child)
    }

    expect(await readFile(lockOf(root, id), 'utf8').catch(() => '')).toBe('')
    const opened = await Effect.runPromise(persistence.open(id))
    expect(opened.events).toHaveLength(1)
  })

  test('a stale lock is taken over and the torn tail is repaired before the next write', async () => {
    const { root, persistence } = isolated()
    const id = 'crashed'
    const torn = encodeZstdFrame(JSON.stringify({ seq: 2, time: 101, type: 'user/message' }) + '\n')
    await seedLog(root, id, torn.subarray(0, torn.length - 5))
    await hold(lockOf(root, id), deadPid())

    const opened = await Effect.runPromise(persistence.open(id))

    expect(opened.events.map((event) => event.type)).toEqual(['session/header', 'session/repaired'])
    await Effect.runPromise(
      opened.sink.append({
        seq: 3,
        time: 102,
        type: 'user/message',
        data: { text: 'after', source: 'user' },
      }),
    )
    const log = splitZstdLog(await readFile(fileOf(root, id)))
    expect(log.tornBytes).toBe(0)
    expect((JSON.parse(await readFile(lockOf(root, id), 'utf8')) as { pid: number }).pid).toBe(
      process.pid,
    )
  })

  test('a lock whose record was cut short is stale too', async () => {
    const { root, persistence } = isolated()
    const id = 'cut-record'
    await seedLog(root, id)
    await writeFile(lockOf(root, id), '{"pid":')

    const opened = await Effect.runPromise(persistence.open(id))

    expect(opened.events).toHaveLength(1)
  })

  test('a reader opens the log while another process writes it', async () => {
    const { root, persistence } = isolated()
    const id = 'reading'
    await seedLog(root, id)
    await hold(lockOf(root, id), process.ppid)

    const readSession = persistence.read
    const read =
      readSession === undefined
        ? (await Effect.runPromise(persistence.open(id))).events
        : await Effect.runPromise(readSession(id))
    expect(read.map((event) => event.type)).toEqual(['session/header'])

    const query = makeSessionQuery({ root, sessions: persistence })
    try {
      const observation = await Effect.runPromise(query.observe(id))
      expect(observation.events).toHaveLength(1)
    } finally {
      query.close()
    }

    const error = await Effect.runPromise(Effect.flip(persistence.open(id)))
    expect(error.message).toContain('being written by another process')
  })

  test('releasing a lock whose file is already gone is harmless', async () => {
    const { root } = isolated()
    await mkdir(root, { recursive: true })
    const path = join(root, 'gone.log')
    const lock = await Effect.runPromise(acquireLock(path, 'gone'))
    await rm(path + LOCK_SUFFIX)

    await Effect.runPromise(lock.release)

    expect(await readFile(path + LOCK_SUFFIX, 'utf8').catch(() => '')).toBe('')
  })

  test('the exit hook drops every lock this process holds', async () => {
    const { root } = isolated()
    await mkdir(root, { recursive: true })
    const first = join(root, 'first.log')
    const second = join(root, 'second.log')
    await Effect.runPromise(acquireLock(first, 'first'))
    await Effect.runPromise(acquireLock(second, 'second'))

    releaseAllLocks()

    expect(await readFile(first + LOCK_SUFFIX, 'utf8').catch(() => '')).toBe('')
    expect(await readFile(second + LOCK_SUFFIX, 'utf8').catch(() => '')).toBe('')
  })

  test('releasing the lock removes it, and leaves a lock another writer took over', async () => {
    const { root } = isolated()
    const path = join(root, 'manual.log')
    await mkdir(root, { recursive: true })
    const lock = await Effect.runPromise(acquireLock(path, 'manual'))
    expect((JSON.parse(await readFile(path + LOCK_SUFFIX, 'utf8')) as { pid: number }).pid).toBe(
      process.pid,
    )

    await Effect.runPromise(lock.release)
    expect(await readFile(path + LOCK_SUFFIX, 'utf8').catch(() => '')).toBe('')

    const again = await Effect.runPromise(acquireLock(path, 'manual'))
    await hold(path + LOCK_SUFFIX, 4_000_000, 'successor')
    await Effect.runPromise(again.release)
    expect(
      (JSON.parse(await readFile(path + LOCK_SUFFIX, 'utf8')) as { token: string }).token,
    ).toBe('successor')
  })
})
