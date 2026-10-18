import { afterAll, describe, expect, test } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { SESSION_FORMAT_VERSION, type SessionHeader } from '@jozo-harness/session'
import { jsonlSessions } from '../src/index.ts'

/**
 * A root this test process owns. One under the repo would be shared with every other
 * process running the suite, and the afterAll below would take their sessions away.
 */
const tempRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-jsonl-'))

/** Every test owns its root so listing cannot observe another test's sessions. */
const isolated = () => {
  const root = join(tempRoot, crypto.randomUUID())
  return { root, persistence: jsonlSessions({ root }) }
}

const header = (cwd = '/work'): SessionHeader => ({
  formatVersion: SESSION_FORMAT_VERSION,
  createdAt: 100,
  cwd,
})

const fileOf = (root: string, id: string): string => join(root, id, 'session.v1.jsonl')

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('jsonlSessions', () => {
  test('create writes a header, append adds a line, and open reconstructs both', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const value = crypto.randomUUID()

    await Effect.runPromise(
      created.sink.append({
        seq: 2,
        time: 101,
        type: 'user/message',
        data: { text: value, source: 'user' },
      }),
    )
    const reopened = await Effect.runPromise(persistence.open(created.id))

    expect(created.events.map((sessionEvent) => sessionEvent.type)).toEqual(['session/header'])
    expect(reopened.events.map((sessionEvent) => sessionEvent.type)).toEqual([
      'session/header',
      'user/message',
    ])
    expect(reopened.events[1]?.data).toEqual({ text: value, source: 'user' })

    const lines = (await readFile(fileOf(root, created.id), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}')).toEqual(created.events[0])
  })

  test('stat and list describe created sessions', async () => {
    const { persistence } = isolated()
    const first = await Effect.runPromise(persistence.create(header('/one')))
    const second = await Effect.runPromise(persistence.create(header('/two')))

    expect(await Effect.runPromise(persistence.stat(first.id))).toEqual({
      id: first.id,
      cwd: '/one',
      createdAt: 100,
      updatedAt: expect.any(Number),
      title: '',
      empty: true,
    })
    const summaries = await Effect.runPromise(persistence.list())
    expect(summaries.map((summary) => summary.id).sort()).toEqual([first.id, second.id].sort())
  })

  test('stat and list carry the moment the log last changed', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const file = fileOf(root, created.id)
    const started = new Date(1_000_000)
    await utimes(file, started, started)
    const before = await Effect.runPromise(persistence.stat(created.id))

    await Effect.runPromise(
      created.sink.append({
        seq: 2,
        time: 101,
        type: 'user/message',
        data: { text: 'one more turn', source: 'user' },
      }),
    )
    const listed = await Effect.runPromise(persistence.list())
    const after = listed[0]

    expect(before.updatedAt).toBe(1_000_000)
    expect(after?.updatedAt ?? 0).toBeGreaterThan(before.updatedAt)
    expect(after?.createdAt).toBe(100)
  })

  test('a session stops being empty once its log holds an event beyond the header', async () => {
    const { persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))

    expect((await Effect.runPromise(persistence.stat(created.id))).empty).toBe(true)
    await Effect.runPromise(
      created.sink.append({
        seq: 2,
        time: 101,
        type: 'user/message',
        data: { text: 'hello', source: 'user' },
      }),
    )
    expect((await Effect.runPromise(persistence.list()))[0]?.empty).toBe(false)
  })

  test('list is empty before the root exists', async () => {
    const { persistence } = isolated()
    expect(await Effect.runPromise(persistence.list())).toEqual([])
  })

  test('open of an unknown id fails with not-found', async () => {
    const { persistence } = isolated()
    const error = await Effect.runPromise(Effect.flip(persistence.open(crypto.randomUUID())))
    expect(error.code).toBe('not-found')
  })

  test('open fails on a malformed line', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await appendFile(fileOf(root, created.id), 'not json\n')

    const error = await Effect.runPromise(Effect.flip(persistence.open(created.id)))

    expect(error.code).toBe('persistence')
    expect(error.message).toContain('JSON')
  })

  test('open fails on an unsupported format version', async () => {
    const { persistence } = isolated()
    const legacy = await Effect.runPromise(
      persistence.create({
        formatVersion: SESSION_FORMAT_VERSION + 99,
        createdAt: 1,
        cwd: '/legacy',
      }),
    )

    const error = await Effect.runPromise(Effect.flip(persistence.open(legacy.id)))

    expect(error.code).toBe('persistence')
    expect(error.message).toContain('formatVersion')
  })

  test('open skips an unknown ignorable event and rejects an unknown required one', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const ignorable = { seq: 2, time: 101, type: 'plugin/unknown', data: {}, ignorable: true }
    await appendFile(fileOf(root, created.id), JSON.stringify(ignorable) + '\n')

    const reopened = await Effect.runPromise(persistence.open(created.id))
    expect(reopened.events).toHaveLength(1)

    await appendFile(
      fileOf(root, created.id),
      JSON.stringify({ seq: 3, time: 102, type: 'plugin/other', data: {} }) + '\n',
    )
    const error = await Effect.runPromise(Effect.flip(persistence.open(created.id)))
    expect(error.message).toContain('plugin/other')
  })
})
