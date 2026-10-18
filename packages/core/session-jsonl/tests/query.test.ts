import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HEADER_READ_BYTES, jsonlSessions, makeSessionQuery, readFirstLine } from '../src/index.ts'

const headerLine = (cwd = '/work'): string =>
  JSON.stringify({
    seq: 1,
    time: 1,
    type: 'session/header',
    data: { formatVersion: 1, createdAt: 1, cwd },
  })

const userLine = (seq: number, text: string): string =>
  JSON.stringify({ seq, time: seq, type: 'user/message', data: { text, source: 'user' } })

const callLine = (seq: number, name: string, args: string): string =>
  JSON.stringify({
    seq,
    time: seq,
    type: 'tool/call',
    data: { callId: 'c1', name, arguments: args },
  })

/** One session directory with exactly the lines the test wrote. */
const writeSession = async (
  root: string,
  id: string,
  lines: ReadonlyArray<string>,
): Promise<void> => {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'session.v1.jsonl'), lines.join('\n') + '\n')
}

const queryAt = (root: string) => makeSessionQuery({ root, sessions: jsonlSessions({ root }) })

describe('readFirstLine', () => {
  test('returns the first line without carrying the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    const path = join(root, 'log.jsonl')
    await writeFile(path, headerLine() + '\n' + userLine(2, 'behind it') + '\n')

    expect(await Effect.runPromise(readFirstLine(path))).toBe(headerLine())
    await rm(root, { recursive: true, force: true })
  })

  test('refuses a first line longer than the budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    const path = join(root, 'log.jsonl')
    await writeFile(path, 'x'.repeat(HEADER_READ_BYTES + 1) + '\n')

    const error = await Effect.runPromise(Effect.flip(readFirstLine(path)))

    expect(error.code).toBe('persistence')
    await rm(root, { recursive: true, force: true })
  })
})

describe('listing a long log', () => {
  test('a log with a huge tail still lists in well under a second', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    const id = 'long-session'
    await writeSession(root, id, [headerLine()])
    // A big sparse tail: reading the whole file would carry it, reading its
    // first line does not.
    await truncate(join(root, id, 'session.v1.jsonl'), 512 * 1024 * 1024)

    const started = performance.now()
    const listed = await Effect.runPromise(jsonlSessions({ root }).list())
    const elapsed = performance.now() - started

    expect(listed).toEqual([
      { id, cwd: '/work', createdAt: 1, updatedAt: expect.any(Number), title: '', empty: false },
    ])
    expect(elapsed).toBeLessThan(1000)
    await rm(root, { recursive: true, force: true })
  })

  test('a ten-thousand-event log lists in under a second', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    const lines = [headerLine()]
    for (let seq = 2; seq <= 10_001; seq += 1) {
      lines.push(userLine(seq, 'event number ' + String(seq)))
    }
    await writeSession(root, 'ten-thousand', lines)

    const started = performance.now()
    const listed = await Effect.runPromise(jsonlSessions({ root }).list())
    const elapsed = performance.now() - started

    expect(listed).toEqual([
      {
        id: 'ten-thousand',
        cwd: '/work',
        createdAt: 1,
        updatedAt: expect.any(Number),
        title: 'event number 2',
        empty: false,
      },
    ])
    expect(elapsed).toBeLessThan(1000)
    await rm(root, { recursive: true, force: true })
  })
})

describe('observing one session', () => {
  test('hands the same cut to every reader that retains it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    await writeSession(root, 's1', [headerLine(), userLine(2, 'the first word')])
    const query = queryAt(root)

    const first = await Effect.runPromise(query.observe('s1'))
    const second = await Effect.runPromise(query.observe('s1'))
    expect(first.header.cwd).toBe('/work')
    expect(first.events).toHaveLength(2)
    expect(second.events).toBe(first.events)

    // A lease outlives the readers that disposed; the entry goes with the last one.
    const held = first.retain()
    first.dispose()
    second.dispose()
    const third = await Effect.runPromise(query.observe('s1'))
    expect(third.events).toBe(held.events)
    third.dispose()
    held.dispose()

    const after = await Effect.runPromise(query.observe('s1'))
    expect(after.events).not.toBe(third.events)
    after.dispose()
    query.close()
    await rm(root, { recursive: true, force: true })
  })

  test('a file that changed since the cut is read again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    await writeSession(root, 's1', [headerLine(), userLine(2, 'before')])
    const query = queryAt(root)
    const before = await Effect.runPromise(query.observe('s1'))
    before.dispose()

    await writeSession(root, 's1', [headerLine(), userLine(2, 'before'), userLine(3, 'after')])
    const after = await Effect.runPromise(query.observe('s1'))

    expect(after.events).toHaveLength(3)
    expect(after.events).not.toBe(before.events)
    after.dispose()
    query.close()
    await rm(root, { recursive: true, force: true })
  })
})

describe('the full-text index', () => {
  test('answers a search from the index, marking the match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    await writeSession(root, 's1', [
      headerLine(),
      userLine(2, 'how many files are there'),
      userLine(3, 'unrelated words'),
    ])
    await writeSession(root, 's2', [headerLine('/other'), userLine(2, 'nothing to find here')])
    const query = queryAt(root)

    const hits = await Effect.runPromise(query.search('files are'))

    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe('s1')
    expect(hits[0]?.seq).toBe(2)
    expect(hits[0]?.text).toContain('«files are»')
    query.close()
    await rm(root, { recursive: true, force: true })
  })

  test('indexes tool calls and skips what did not change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    await writeSession(root, 's1', [
      headerLine(),
      callLine(2, 'bash', '{"command":"rg needle-special"}'),
    ])
    const query = queryAt(root)

    const first = await Effect.runPromise(query.sync())
    const second = await Effect.runPromise(query.sync())
    const hits = await Effect.runPromise(query.search('needle-special'))

    expect(first.indexed).toEqual(['s1'])
    expect(second.skipped).toBe(1)
    expect(hits[0]?.type).toBe('tool/call')
    query.close()
    await rm(root, { recursive: true, force: true })
  })

  test('a file that changed is indexed again, and a removed session drops out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    await writeSession(root, 's1', [headerLine(), userLine(2, 'the old words')])
    await writeSession(root, 's2', [headerLine(), userLine(2, 'the doomed words')])
    const query = queryAt(root)
    await Effect.runPromise(query.sync())

    await writeSession(root, 's1', [
      headerLine(),
      userLine(2, 'the old words'),
      userLine(3, 'and brand new words'),
    ])
    await rm(join(root, 's2'), { recursive: true, force: true })
    const report = await Effect.runPromise(query.sync())

    expect(report.indexed).toEqual(['s1'])
    expect(report.removed).toEqual(['s2'])
    expect(await Effect.runPromise(query.search('brand new'))).toHaveLength(1)
    expect(await Effect.runPromise(query.search('doomed'))).toEqual([])
    query.close()
    await rm(root, { recursive: true, force: true })
  })

  test('an empty search asks nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-query-'))
    const query = queryAt(root)

    expect(await Effect.runPromise(query.search('   '))).toEqual([])
    query.close()
    await rm(root, { recursive: true, force: true })
  })
})
