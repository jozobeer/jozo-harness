import { afterAll, describe, expect, test } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import {
  SESSION_FORMAT_VERSION,
  decodeProjectionCheckpoint,
  deriveMessages,
  makeSession,
  type OpenedSession,
  type Session,
  type SessionHeader,
  type SessionSink,
} from '@jozo-harness/session'
import { PROJECTION_FILE_NAME, jsonlSessions as makeJsonlSessions } from '../src/index.ts'

const tempRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-projection-'))

const isolated = () => {
  const root = join(tempRoot, crypto.randomUUID())
  return { root, persistence: makeJsonlSessions({ root }) }
}

const header = (cwd = '/work'): SessionHeader => ({
  formatVersion: SESSION_FORMAT_VERSION,
  createdAt: 100,
  cwd,
})

const sessionOf = (opened: OpenedSession) =>
  makeSession({ id: opened.id, events: opened.events, sink: opened.sink })

const appendUser = (session: Session, text: string) =>
  Effect.runPromise(session.append('user/message', { text, source: 'user' }))

const loadProjectionOf = (sink: SessionSink) => {
  const load = sink.loadProjection
  if (load === undefined) throw new Error('the jsonl sink holds projection checkpoints')
  return load
}

const readCheckpoint = async (path: string) =>
  decodeProjectionCheckpoint(JSON.parse(await readFile(path, 'utf8')))

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('jsonl projection checkpoints', () => {
  test('flush writes a checkpoint beside the log and the next open loads it', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const session = await Effect.runPromise(sessionOf(created))

    await appendUser(session, 'one')
    await appendUser(session, 'two')
    await Effect.runPromise(session.flush())

    const directory = join(root, created.id)
    const checkpoint = await readCheckpoint(join(directory, PROJECTION_FILE_NAME))
    expect(checkpoint?.version).toBe(1)
    expect(checkpoint?.seq).toBe(3)
    expect(checkpoint?.derived).toHaveLength(2)
    expect(checkpoint?.log.size).toBeGreaterThan(0)
    // The temp file is renamed, so a reader never sees a half-written checkpoint.
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const reopened = await Effect.runPromise(persistence.open(created.id))
    const stored = await Effect.runPromise(loadProjectionOf(reopened.sink)())
    expect(stored?.seq).toBe(3)

    const resumed = await Effect.runPromise(sessionOf(reopened))
    expect(resumed.derive()).toEqual(deriveMessages(reopened.events))
  })

  test('an unreadable checkpoint is discarded and the whole log is folded', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const session = await Effect.runPromise(sessionOf(created))
    await appendUser(session, 'one')
    await Effect.runPromise(session.flush())

    const path = join(root, created.id, PROJECTION_FILE_NAME)
    await writeFile(path, '{"version":1,')

    const reopened = await Effect.runPromise(persistence.open(created.id))
    expect(await Effect.runPromise(loadProjectionOf(reopened.sink)())).toBeUndefined()

    const resumed = await Effect.runPromise(sessionOf(reopened))
    expect(resumed.derive()).toEqual(deriveMessages(reopened.events))
  })

  test('a checkpoint from another layout is discarded', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const session = await Effect.runPromise(sessionOf(created))
    await appendUser(session, 'one')
    await Effect.runPromise(session.flush())

    const path = join(root, created.id, PROJECTION_FILE_NAME)
    const stored = await readCheckpoint(path)
    if (stored === undefined) throw new Error('the checkpoint should read back')
    await writeFile(path, JSON.stringify({ ...stored, version: 2 }))

    const reopened = await Effect.runPromise(persistence.open(created.id))
    expect(await Effect.runPromise(loadProjectionOf(reopened.sink)())).toBeUndefined()
  })

  test('a checkpoint whose log was replaced is discarded', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const session = await Effect.runPromise(sessionOf(created))
    await appendUser(session, 'one')
    await Effect.runPromise(session.flush())

    const path = join(root, created.id, PROJECTION_FILE_NAME)
    const stored = await readCheckpoint(path)
    if (stored === undefined) throw new Error('the checkpoint should read back')
    await writeFile(
      path,
      JSON.stringify({ ...stored, log: { ...stored.log, size: Number.MAX_SAFE_INTEGER } }),
    )

    const reopened = await Effect.runPromise(persistence.open(created.id))
    expect(await Effect.runPromise(loadProjectionOf(reopened.sink)())).toBeUndefined()
  })
})
