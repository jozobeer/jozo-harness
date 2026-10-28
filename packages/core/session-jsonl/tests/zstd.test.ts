import { SESSION_FORMAT_VERSION, type SessionHeader } from '@jozo-harness/session'
import { Effect } from 'effect'
import { afterAll, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeZstdFrame,
  jsonlSessions,
  makeSessionQuery,
  SESSION_FILE_NAME,
  SESSION_ZSTD_FILE_NAME,
  splitZstdLog,
  zstdText,
} from '../src/index.ts'

/** A root this test process owns; every test takes a directory of its own inside it. */
const tempRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-zstd-'))

const isolated = () => {
  const root = join(tempRoot, crypto.randomUUID())
  return { root, persistence: jsonlSessions({ root }) }
}

const header = (cwd = '/work'): SessionHeader => ({
  formatVersion: SESSION_FORMAT_VERSION,
  createdAt: 100,
  cwd,
})

const zstdFileOf = (root: string, id: string): string => join(root, id, SESSION_ZSTD_FILE_NAME)

const line = (seq: number, type: string, data: unknown): string =>
  JSON.stringify({ seq, time: seq, type, data }) + '\n'

const typesOf = (events: ReadonlyArray<{ readonly type: string }>): ReadonlyArray<string> =>
  events.map((event) => event.type)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('a session log written by this build', () => {
  test('is zstd, with one more frame for every append', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await Effect.runPromise(
      created.sink.append({
        seq: 2,
        time: 101,
        type: 'user/message',
        data: { text: 'one', source: 'user' },
      }),
    )
    await Effect.runPromise(
      created.sink.append({
        seq: 3,
        time: 102,
        type: 'user/message',
        data: { text: 'two', source: 'user' },
      }),
    )

    const bytes = await readFile(zstdFileOf(root, created.id))
    const split = splitZstdLog(bytes)

    // The magic dsh writes too; a plaintext log would start with '{'.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    expect(split.frames).toHaveLength(3)
    expect(split.tornBytes).toBe(0)
    expect(
      split.frames.map(
        (frame) => (JSON.parse(zstdText(frame).trim()) as { readonly type: string }).type,
      ),
    ).toEqual(['session/header', 'user/message', 'user/message'])
  })

  test('a listing reads the zstd log without rewriting it', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await Effect.runPromise(
      created.sink.append({
        seq: 2,
        time: 101,
        type: 'user/message',
        data: { text: 'the first word', source: 'user' },
      }),
    )
    const file = zstdFileOf(root, created.id)
    const before = await readFile(file)

    const summary = await Effect.runPromise(persistence.stat(created.id))
    const listed = await Effect.runPromise(persistence.list())

    expect(summary).toMatchObject({
      id: created.id,
      cwd: '/work',
      createdAt: 100,
      title: 'the first word',
      empty: false,
    })
    expect(listed.map((entry) => entry.id)).toEqual([created.id])
    expect(await readFile(file)).toEqual(before)
  })

  test('the full-text index reads the zstd log', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await Effect.runPromise(
      created.sink.append({
        seq: 2,
        time: 101,
        type: 'user/message',
        data: { text: 'needle in a zstd log', source: 'user' },
      }),
    )
    const query = makeSessionQuery({ root, sessions: persistence })

    const hits = await Effect.runPromise(query.search('needle'))

    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe(created.id)
    query.close()
  })
})

describe('a zstd log a crash cut short', () => {
  test('keeps every complete frame and records the repair at the frame boundary', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    for (const seq of [2, 3]) {
      await Effect.runPromise(
        created.sink.append({
          seq,
          time: seq,
          type: 'user/message',
          data: { text: 'event ' + String(seq), source: 'user' },
        }),
      )
    }
    const file = zstdFileOf(root, created.id)
    const whole = await readFile(file)
    const before = splitZstdLog(whole)
    const cut = 3
    await truncate(file, whole.byteLength - cut)
    const torn = (before.frames[before.frames.length - 1]?.byteLength ?? 0) - cut

    const opened = await Effect.runPromise(persistence.open(created.id))

    // The cut frame held the third event; the two complete frames before it stay.
    expect(typesOf(opened.events)).toEqual(['session/header', 'user/message', 'session/repaired'])
    const repaired = opened.events[2]
    expect(repaired?.type === 'session/repaired' && repaired.data.tornBytes).toBe(torn)

    // The repair is a frame of its own: the file is whole again, and a second
    // open reads it without adding another note.
    const after = splitZstdLog(await readFile(file))
    expect(after.tornBytes).toBe(0)
    expect(after.frames).toHaveLength(3)
    const again = await Effect.runPromise(persistence.open(created.id))
    expect(typesOf(again.events)).toEqual(['session/header', 'user/message', 'session/repaired'])
  })

  test('a log cut off before its header frame cannot open', async () => {
    const { root, persistence } = isolated()
    const created = await Effect.runPromise(persistence.create(header()))
    await truncate(zstdFileOf(root, created.id), 4)

    const failed = await Effect.runPromise(Effect.result(persistence.open(created.id)))

    expect(failed._tag).toBe('Failure')
    expect(failed._tag === 'Failure' && failed.failure.message).toContain('before its header')
  })

  test('a complete frame that is not zstd is refused, not read as a torn tail', async () => {
    const root = join(tempRoot, crypto.randomUUID())
    const id = 'broken'
    await mkdir(join(root, id), { recursive: true })
    const headerLine = line(1, 'session/header', {
      formatVersion: SESSION_FORMAT_VERSION,
      createdAt: 100,
      cwd: '/work',
    })
    await writeFile(
      join(root, id, SESSION_ZSTD_FILE_NAME),
      Buffer.concat([encodeZstdFrame(headerLine), Buffer.from('nope')]),
    )

    const failed = await Effect.runPromise(Effect.result(jsonlSessions({ root }).open(id)))

    expect(failed._tag).toBe('Failure')
    expect(failed._tag === 'Failure' && failed.failure.message).toContain('cannot read')
  })
})

describe('a log written before this build', () => {
  test('opens as plaintext and keeps appending plaintext', async () => {
    const root = join(tempRoot, crypto.randomUUID())
    const id = 'plain'
    await mkdir(join(root, id), { recursive: true })
    const file = join(root, id, SESSION_FILE_NAME)
    const original =
      line(1, 'session/header', {
        formatVersion: SESSION_FORMAT_VERSION,
        createdAt: 100,
        cwd: '/work',
      }) + line(2, 'user/message', { text: 'before', source: 'user' })
    await writeFile(file, original)

    const opened = await Effect.runPromise(jsonlSessions({ root }).open(id))
    expect(typesOf(opened.events)).toEqual(['session/header', 'user/message'])

    await Effect.runPromise(
      opened.sink.append({
        seq: 3,
        time: 103,
        type: 'user/message',
        data: { text: 'after', source: 'user' },
      }),
    )

    const text = await readFile(file, 'utf8')
    expect(text.startsWith(original)).toBe(true)
    expect(text.trim().split('\n')).toHaveLength(3)
    // The format was not switched under the session.
    expect(await readdir(join(root, id))).toEqual([SESSION_FILE_NAME])
  })

  test('wins over a zstd log when both files exist', async () => {
    const root = join(tempRoot, crypto.randomUUID())
    const id = 'both'
    await mkdir(join(root, id), { recursive: true })
    await writeFile(
      join(root, id, SESSION_FILE_NAME),
      line(1, 'session/header', {
        formatVersion: SESSION_FORMAT_VERSION,
        createdAt: 100,
        cwd: '/plain',
      }) + line(2, 'user/message', { text: 'plain wins', source: 'user' }),
    )
    await writeFile(
      join(root, id, SESSION_ZSTD_FILE_NAME),
      encodeZstdFrame(
        line(1, 'session/header', {
          formatVersion: SESSION_FORMAT_VERSION,
          createdAt: 100,
          cwd: '/zstd',
        }) + line(2, 'user/message', { text: 'zstd loses', source: 'user' }),
      ),
    )

    const opened = await Effect.runPromise(jsonlSessions({ root }).open(id))

    expect(opened.events[0]?.type === 'session/header' && opened.events[0].data.cwd).toBe('/plain')
    expect(opened.events[1]?.type === 'user/message' && opened.events[1].data.text).toBe(
      'plain wins',
    )
  })
})
