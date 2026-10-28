import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TITLE_MAX_CHARS, readTitle } from '../src/index.ts'

const header = (): string =>
  JSON.stringify({
    seq: 1,
    time: 1,
    type: 'session/header',
    data: { formatVersion: 1, createdAt: 1, cwd: '/work' },
  })

const message = (seq: number, source: string, text: string): string =>
  JSON.stringify({ seq, time: seq, type: 'user/message', data: { text, source } })

const titleEvent = (seq: number, title: string, source: 'model' | 'human' | 'fallback'): string =>
  JSON.stringify({ seq, time: seq, type: 'session/title', data: { title, source } })

/** One log file holding exactly these lines, and nothing else. */
const writeLog = async (lines: ReadonlyArray<string>): Promise<{ root: string; path: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-title-'))
  const path = join(root, 'session.v1.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return { root, path }
}

describe('the title of a session', () => {
  test('the first thing the human typed names it', async () => {
    const written = await writeLog([
      header(),
      JSON.stringify({
        seq: 2,
        time: 2,
        type: 'system/message',
        data: { text: 'you are an agent' },
      }),
      message(3, 'user', 'count the files'),
      message(4, 'user', 'and the directories'),
    ])
    const title = await Effect.runPromise(readTitle(written.path))
    expect(title).toBe('count the files')
    await rm(written.root, { recursive: true, force: true })
  })

  test('the name a model wrote is read from the same head as the message', async () => {
    const written = await writeLog([
      header(),
      message(2, 'user', 'please fix the flaky login test that only fails on CI sometimes'),
      titleEvent(3, 'flaky login test', 'model'),
    ])
    const title = await Effect.runPromise(readTitle(written.path))
    expect(title).toBe('flaky login test')
    await rm(written.root, { recursive: true, force: true })
  })

  test('a human name beats the model name in the head', async () => {
    const written = await writeLog([
      header(),
      message(2, 'user', 'count the files'),
      titleEvent(3, 'counting files', 'model'),
      titleEvent(4, 'my own name', 'human'),
    ])
    const title = await Effect.runPromise(readTitle(written.path))
    expect(title).toBe('my own name')
    await rm(written.root, { recursive: true, force: true })
  })

  test('what the harness injected does not name the session', async () => {
    const written = await writeLog([
      header(),
      message(2, 'runtime-context', 'cwd: /work\ntime: 2026'),
      message(3, 'inject', 'AGENTS.md says hello'),
      message(4, 'user', 'the real ask'),
    ])
    const title = await Effect.runPromise(readTitle(written.path))
    expect(title).toBe('the real ask')
    await rm(written.root, { recursive: true, force: true })
  })

  test('a line that is not JSON is skipped, not fatal', async () => {
    const written = await writeLog([
      header(),
      '{"seq":2,"time":2,"type":"user/mess',
      message(3, 'user', 'still found'),
    ])
    const title = await Effect.runPromise(readTitle(written.path))
    expect(title).toBe('still found')
    await rm(written.root, { recursive: true, force: true })
  })

  test('a log with nothing the human typed stays unnamed', async () => {
    const written = await writeLog([header(), message(2, 'inject', 'no ask')])
    const title = await Effect.runPromise(readTitle(written.path))
    expect(title).toBe('')
    await rm(written.root, { recursive: true, force: true })
  })

  test('a message becomes one short line', async () => {
    const long = 'x'.repeat(TITLE_MAX_CHARS * 2)
    const written = await writeLog([header(), message(2, 'user', 'first line\n\n' + long)])
    const title = await Effect.runPromise(readTitle(written.path))
    expect(title.startsWith('first line ')).toBe(true)
    expect(title.length).toBe(TITLE_MAX_CHARS)
    expect(title.endsWith('…')).toBe(true)
    await rm(written.root, { recursive: true, force: true })
  })

  test('a session whose first words sit past the budget stays unnamed', async () => {
    const filler = message(2, 'inject', 'x'.repeat(200 * 1024))
    const written = await writeLog([header(), filler, message(3, 'user', 'too far in')])
    const title = await Effect.runPromise(readTitle(written.path))
    expect(title).toBe('')
    await rm(written.root, { recursive: true, force: true })
  })
})
