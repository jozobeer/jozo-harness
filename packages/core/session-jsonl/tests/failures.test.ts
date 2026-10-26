import { afterAll, describe, expect, test } from 'vitest'
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { SESSION_FORMAT_VERSION, type SessionHeader } from '@jozo-harness/session'
import { jsonlSessions } from '../src/index.ts'

/** A root this test process owns; every test takes a directory of its own inside it. */
const tempRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-jsonl-failures-'))

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

describe('jsonlSessions failures', () => {
  test('flush leaves the appended events readable', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await Effect.runPromise(
      created.sink.append({
        seq: 2,
        time: 101,
        type: 'user/message',
        data: { text: 'hi', source: 'user' },
      }),
    )

    await Effect.runPromise(created.sink.flush())

    const lines = (await readFile(fileOf(root, created.id), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  test('flush reports a session directory that is gone', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await rm(join(root, created.id), { recursive: true, force: true })

    const error = await Effect.runPromise(Effect.flip(created.sink.flush()))

    expect(error.code).toBe('persistence')
    expect(error.message).toContain('cannot flush')
  })

  test('append reports a session directory that is gone', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await rm(join(root, created.id), { recursive: true, force: true })

    const error = await Effect.runPromise(
      Effect.flip(
        created.sink.append({
          seq: 2,
          time: 101,
          type: 'user/message',
          data: { text: 'hi', source: 'user' },
        }),
      ),
    )

    expect(error.code).toBe('persistence')
    expect(error.message).toContain('cannot append')
  })

  test('open reports a log it cannot read', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await rm(fileOf(root, created.id))
    await mkdir(fileOf(root, created.id), { recursive: true })

    const error = await Effect.runPromise(Effect.flip(persistence.open(created.id)))

    expect(error.code).toBe('persistence')
    expect(error.message).toContain('cannot read')
  })

  test('create reports a root that is a file', async () => {
    const root = join(tempRoot, crypto.randomUUID())
    await writeFile(root, 'not a directory')

    const error = await Effect.runPromise(Effect.flip(jsonlSessions({ root }).create(header())))

    expect(error.code).toBe('persistence')
    expect(error.message).toContain('cannot create')
  })

  test('a repair that cannot be written still opens the kept prefix', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const file = fileOf(root, created.id)
    const directory = join(root, created.id)
    // A torn tail: a line that never finished, so the log is worth repairing.
    await appendFile(file, '{"seq":2,"time":101,"type":"user/message"')
    const before = await readFile(file, 'utf8')
    // The directory, not the file: a rename can replace a read-only inode.
    await chmod(directory, 0o500)

    try {
      const opened = await Effect.runPromise(persistence.open(created.id))

      // The note is in the session so the next seq stays past it, but the torn
      // file is left untouched until a later append can rewrite it.
      expect(opened.events.map((event) => event.type)).toEqual([
        'session/header',
        'session/repaired',
      ])
      expect(await readFile(file, 'utf8')).toBe(before)
    } finally {
      await chmod(directory, 0o700)
    }
  })

  test('an append after a failed repair rewrites the kept lines instead of gluing the torn tail', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const file = fileOf(root, created.id)
    const directory = join(root, created.id)
    const torn = '{"seq":2,"time":101,"type":"user/message"'
    await appendFile(file, torn)
    await chmod(directory, 0o500)
    const opened = await Effect.runPromise(persistence.open(created.id))
    await chmod(directory, 0o700)

    await Effect.runPromise(
      opened.sink.append({
        seq: 3,
        time: 102,
        type: 'user/message',
        data: { text: 'after', source: 'user' },
      }),
    )

    const text = await readFile(file, 'utf8')
    expect(text.includes(torn)).toBe(false)
    const parsed = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; seq: number })
    expect(parsed.map((event) => event.type)).toEqual([
      'session/header',
      'session/repaired',
      'user/message',
    ])
    expect(parsed.map((event) => event.seq)).toEqual([1, 2, 3])
    const again = await Effect.runPromise(persistence.open(created.id))
    expect(again.events.map((event) => event.type)).toEqual([
      'session/header',
      'session/repaired',
      'user/message',
    ])
  })

  test('an append that cannot repair the torn log leaves the file unchanged', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    const file = fileOf(root, created.id)
    const directory = join(root, created.id)
    await appendFile(file, '{"seq":2,"time":101,"type":"user/message"')
    await chmod(directory, 0o500)
    const before = await readFile(file, 'utf8')

    try {
      const opened = await Effect.runPromise(persistence.open(created.id))
      const error = await Effect.runPromise(
        Effect.flip(
          opened.sink.append({
            seq: 3,
            time: 102,
            type: 'user/message',
            data: { text: 'after', source: 'user' },
          }),
        ),
      )

      expect(error.message).toContain('cannot append')
      expect(await readFile(file, 'utf8')).toBe(before)
    } finally {
      await chmod(directory, 0o700)
    }
  })

  test('list skips a directory whose log is gone', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await rm(fileOf(root, created.id))

    expect(await Effect.runPromise(persistence.list())).toEqual([])
  })
})
