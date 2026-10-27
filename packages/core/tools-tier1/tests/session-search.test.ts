import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  makeSessionSearchTool,
  SESSION_SEARCH_TEXT_CHARS,
  type SessionSearchArgs,
  type SessionSearchHit,
} from '../src/index.ts'

const hit = (sessionId: string, text: string): SessionSearchHit => ({
  sessionId,
  seq: 1,
  type: 'message',
  text,
})

const execContext = { sessionId: 'caller', cwd: '/work/current', callId: 'c1' }

const makeTool = (
  hits: ReadonlyArray<SessionSearchHit>,
  cwds: Record<string, string>,
  searched: Array<number> = [],
) => {
  const tool = makeSessionSearchTool({
    search: (text, limit) =>
      Effect.sync(() => {
        searched.push(limit)
        return hits.filter((entry) => entry.text.includes(text))
      }),
    cwdOf: (sessionId) => cwds[sessionId],
    cwd: '/work/current',
  })
  const exec = (args: SessionSearchArgs) => Effect.runPromise(tool.execute(args, execContext))
  return { tool, exec }
}

describe('session_search tool', () => {
  test('returns only the hits from this workspace', async () => {
    const { exec } = makeTool([hit('s1', 'the build broke'), hit('s2', 'the build broke too')], {
      s1: '/work/current',
      s2: '/work/elsewhere',
    })

    await expect(exec({ query: 'build' })).resolves.toEqual({
      hits: [{ sessionId: 's1', text: 'the build broke' }],
    })
  })

  test('drops a hit whose session has no known workspace', async () => {
    const { exec } = makeTool([hit('s1', 'build'), hit('s9', 'build')], { s1: '/work/current' })

    const value = await exec({ query: 'build' })

    expect(value.hits.map((entry) => entry.sessionId)).toEqual(['s1'])
  })

  test('defaults the limit to 10', async () => {
    const hits = Array.from({ length: 20 }, (_, index) => hit('s' + String(index), 'build'))
    const cwds = Object.fromEntries(hits.map((entry) => [entry.sessionId, '/work/current']))
    const { exec } = makeTool(hits, cwds)

    const value = await exec({ query: 'build' })

    expect(value.hits).toHaveLength(10)
  })

  test('caps the limit at 50', async () => {
    const hits = Array.from({ length: 80 }, (_, index) => hit('s' + String(index), 'build'))
    const cwds = Object.fromEntries(hits.map((entry) => [entry.sessionId, '/work/current']))
    const searched: Array<number> = []
    const { exec } = makeTool(hits, cwds, searched)

    const value = await exec({ query: 'build', limit: 500 })

    expect(value.hits).toHaveLength(50)
    expect(searched).toEqual([50])
  })

  test('cuts long text to the preview length', async () => {
    const { exec } = makeTool([hit('s1', 'x'.repeat(500))], { s1: '/work/current' })

    const value = await exec({ query: 'x' })

    expect(value.hits[0]?.text).toHaveLength(SESSION_SEARCH_TEXT_CHARS)
  })
})
