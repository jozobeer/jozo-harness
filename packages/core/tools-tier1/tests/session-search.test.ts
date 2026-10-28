import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import type { SessionEvent } from '@jozo-harness/session'
import {
  makeSessionEventReadTool,
  makeSessionSearchTool,
  makeSessionTraceTool,
  SESSION_SEARCH_TEXT_CHARS,
  SESSION_TRACE_SUMMARY_CHARS,
  type SessionEventReadArgs,
  type SessionSearchArgs,
  type SessionSearchHit,
  type SessionSearchHost,
  type SessionTraceArgs,
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
    eventsOf: () => Effect.succeed([]),
    cwd: '/work/current',
  })
  const exec = (args: SessionSearchArgs) => Effect.runPromise(tool.execute(args, execContext))
  return { tool, exec }
}

/** One user message, the simplest event a trace or a read has to show. */
const message = (seq: number, text: string): SessionEvent => ({
  seq,
  time: 1000 + seq,
  type: 'user/message',
  data: { text, source: 'user' },
})

const messages = (count: number): ReadonlyArray<SessionEvent> =>
  Array.from({ length: count }, (_, index) => message(index + 1, 'line ' + String(index + 1)))

/** A host that serves one log to whichever session the test names, and remembers reads. */
const readingHost = (
  events: ReadonlyArray<SessionEvent>,
  cwds: Record<string, string>,
  opened: Array<string> = [],
): SessionSearchHost => ({
  search: () => Effect.succeed([]),
  cwdOf: (sessionId) => cwds[sessionId],
  eventsOf: (sessionId) =>
    Effect.sync(() => {
      opened.push(sessionId)
      return events
    }),
  cwd: '/work/current',
})

const runTrace = (host: SessionSearchHost, args: SessionTraceArgs) =>
  Effect.runPromise(makeSessionTraceTool(host).execute(args, execContext))

const runRead = (host: SessionSearchHost, args: SessionEventReadArgs) =>
  Effect.runPromise(makeSessionEventReadTool(host).execute(args, execContext))

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

describe('session_trace tool', () => {
  test('lists events as seq, type, and a short summary', async () => {
    const value = await runTrace(readingHost(messages(3), { s1: '/work/current' }), {
      sessionId: 's1',
    })

    expect(value).toEqual({
      sessionId: 's1',
      events: [
        { seq: 1, type: 'user/message', summary: 'line 1' },
        { seq: 2, type: 'user/message', summary: 'line 2' },
        { seq: 3, type: 'user/message', summary: 'line 3' },
      ],
    })
  })

  test('defaults to the newest 20 events', async () => {
    const value = await runTrace(readingHost(messages(30), { s1: '/work/current' }), {
      sessionId: 's1',
    })

    expect(value.events).toHaveLength(20)
    expect(value.events[0]?.seq).toBe(11)
    expect(value.events.at(-1)?.seq).toBe(30)
  })

  test('caps the limit at 200', async () => {
    const value = await runTrace(readingHost(messages(260), { s1: '/work/current' }), {
      sessionId: 's1',
      limit: 500,
    })

    expect(value.events).toHaveLength(200)
    expect(value.events[0]?.seq).toBe(61)
  })

  test('cuts the summary but keeps its first line', async () => {
    const long = 'first line\n' + 'x'.repeat(500)
    const value = await runTrace(readingHost([message(1, long)], { s1: '/work/current' }), {
      sessionId: 's1',
    })

    expect(value.events[0]?.summary).toHaveLength(SESSION_TRACE_SUMMARY_CHARS)
    expect(value.events[0]?.summary.startsWith('first line x')).toBe(true)
  })

  test('rejects a session from another workspace without reading it', async () => {
    const opened: Array<string> = []
    const host = readingHost([message(1, 'secret')], { s1: '/work/elsewhere' }, opened)

    await expect(runTrace(host, { sessionId: 's1' })).rejects.toMatchObject({
      code: 'invalid-arguments',
    })
    expect(opened).toEqual([])
  })

  test('rejects an unknown session as invalid arguments', async () => {
    await expect(runTrace(readingHost([], {}), { sessionId: 'gone' })).rejects.toMatchObject({
      code: 'invalid-arguments',
    })
  })

  test('renders a session line and one line per event', () => {
    const tool = makeSessionTraceTool(readingHost([], { s1: '/work/current' }))

    const blocks = tool.output.render(
      { sessionId: 's1' },
      {
        sessionId: 's1',
        events: [
          { seq: 1, type: 'turn/start', summary: '' },
          { seq: 2, type: 'user/message', summary: 'line 2' },
        ],
      },
    )

    expect(blocks).toEqual([
      {
        type: 'text',
        text: 'session s1\nseq 1 turn/start\nseq 2 user/message: line 2',
      },
    ])
  })
})

describe('session_event_read tool', () => {
  test('reads the event with three neighbors on each side by default', async () => {
    const value = await runRead(readingHost(messages(10), { s1: '/work/current' }), {
      sessionId: 's1',
      seq: 5,
    })

    expect(value.target).toEqual({ seq: 5, type: 'user/message', text: 'line 5' })
    expect(value.before.map((entry) => entry.seq)).toEqual([2, 3, 4])
    expect(value.after.map((entry) => entry.seq)).toEqual([6, 7, 8])
  })

  test('honors before and after and leaves the ends of the log alone', async () => {
    const value = await runRead(readingHost(messages(4), { s1: '/work/current' }), {
      sessionId: 's1',
      seq: 2,
      before: 9,
      after: 0,
    })

    expect(value.before.map((entry) => entry.seq)).toEqual([1])
    expect(value.after).toEqual([])
  })

  test('caps before and after at 20', async () => {
    const value = await runRead(readingHost(messages(100), { s1: '/work/current' }), {
      sessionId: 's1',
      seq: 50,
      before: 500,
      after: 500,
    })

    expect(value.before).toHaveLength(20)
    expect(value.after).toHaveLength(20)
    expect(value.before[0]?.seq).toBe(30)
    expect(value.after.at(-1)?.seq).toBe(70)
  })

  test('keeps the full body the trace summary cuts', async () => {
    const long = 'x'.repeat(500)
    const value = await runRead(readingHost([message(1, long)], { s1: '/work/current' }), {
      sessionId: 's1',
      seq: 1,
      before: 0,
      after: 0,
    })

    expect(value.target.text).toHaveLength(500)
  })

  test('reads assistant prose and structural data in the same window', async () => {
    const events: ReadonlyArray<SessionEvent> = [
      {
        seq: 1,
        time: 1001,
        type: 'assistant/message',
        data: {
          provider: 'stub',
          model: 'model',
          content: [{ type: 'text', text: 'the answer' }],
          stream: [],
        },
      },
      { seq: 2, time: 1002, type: 'turn/start', data: { turn: 1 } },
    ]

    const value = await runRead(readingHost(events, { s1: '/work/current' }), {
      sessionId: 's1',
      seq: 1,
      before: 0,
      after: 1,
    })

    expect(value.target.text).toBe('the answer')
    expect(value.after[0]?.text).toBe('{"turn":1}')
  })

  test('renders the target and the window around it', () => {
    const tool = makeSessionEventReadTool(readingHost([], { s1: '/work/current' }))

    const blocks = tool.output.render(
      { sessionId: 's1', seq: 2 },
      {
        sessionId: 's1',
        target: { seq: 2, type: 'user/message', text: 'target body' },
        before: [{ seq: 1, type: 'turn/start', text: '{"turn":1}' }],
        after: [],
      },
    )

    expect(blocks).toEqual([
      {
        type: 'text',
        text: 'session s1\n> seq 2 user/message\n>   target body\n\nbefore:\n  seq 1 turn/start\n    {"turn":1}',
      },
    ])
  })

  test('rejects a seq the session does not hold', async () => {
    await expect(
      runRead(readingHost(messages(2), { s1: '/work/current' }), { sessionId: 's1', seq: 9 }),
    ).rejects.toMatchObject({ code: 'invalid-arguments' })
  })

  test('rejects a session from another workspace without reading it', async () => {
    const opened: Array<string> = []
    const host = readingHost([message(1, 'secret')], { s1: '/work/elsewhere' }, opened)

    await expect(runRead(host, { sessionId: 's1', seq: 1 })).rejects.toMatchObject({
      code: 'invalid-arguments',
    })
    expect(opened).toEqual([])
  })
})
