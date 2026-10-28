import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { SESSION_FORMAT_VERSION, sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { sessionSearchPlugin, tier1Plugin } from '@jozo-harness/tools-tier1'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const callTurn = (name: string, args: unknown, id: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const searchTurn = (query: string): ReadonlyArray<StreamChunk> =>
  callTurn('session_search', { query }, 'c1')

const stubLlm = (scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>): Plugin<{}, Llm, never> => {
  let call = 0
  return {
    name: 'stub-llm',
    config: Schema.Struct({}),
    provides: [Llm],
    requires: [],
    layer: () =>
      Layer.succeed(Llm, {
        name: 'stub',
        capabilities: {
          toolChoice: false,
          reasoningEffort: null,
          images: 'none',
          promptCacheControl: false,
        },
        stream: () => {
          const script = scripts[call] ?? []
          call += 1
          return Stream.fromIterable(script)
        },
      } satisfies LlmAdapter),
  }
}

type SearchRow = 'enabled' | 'disabled' | 'absent'

/** The shipping profile with the session-search row in the state a test needs. */
const profile = (root: string, row: SearchRow): string =>
  [
    'name: session-search',
    'plugins:',
    '  - id: kernel',
    "    name: '@jozo-harness/kernel'",
    '  - id: sessions',
    "    name: '@jozo-harness/session'",
    '  - id: session-jsonl',
    "    name: '@jozo-harness/session-jsonl'",
    '    config:',
    '      root: ' + root,
    '  - id: tools',
    "    name: '@jozo-harness/tools'",
    '  - id: system-prompt',
    "    name: '@jozo-harness/system-prompt'",
    '  - id: safety',
    "    name: '@jozo-harness/safety'",
    '    config:',
    '      preset: workspace-write',
    '  - id: ask',
    "    name: '@jozo-harness/ask'",
    '  - id: tier0',
    "    name: '@jozo-harness/tools-tier0'",
    '  - id: tier1',
    "    name: '@jozo-harness/tools-tier1'",
    ...(row === 'absent'
      ? []
      : [
          '  - id: session-search',
          "    name: '@jozo-harness/session-search'",
          ...(row === 'disabled' ? ['    disabled: true'] : []),
        ]),
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const pluginsWith = (llm: Plugin<{}, Llm, never>): ReadonlyArray<Plugin<any, any, any>> => [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  safetyPlugin,
  askPlugin,
  tier0Plugin,
  tier1Plugin,
  sessionSearchPlugin,
  llm,
  agentPlugin,
  agentLoopPlugin,
]

const run = (
  root: string,
  workspace: string,
  row: SearchRow,
  scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>,
) =>
  Effect.runPromise(
    runCommand({
      profiles: [profile(root, row)],
      plugins: pluginsWith(stubLlm(scripts)),
      cwd: workspace,
      route: 'stub/model',
      task: 'find the needle',
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  )

/** The tool names the run recorded in the composition of its first session. */
const toolsOfFirstSession = async (root: string): Promise<ReadonlyArray<string>> => {
  const store = jsonlSessions({ root })
  const listed = await Effect.runPromise(store.list())
  const opened = await Effect.runPromise(store.open(listed[0]?.id ?? ''))
  return (
    opened.events.flatMap((event) =>
      event.type === 'preset/selected' ? [event.data.tools] : [],
    )[0] ?? []
  )
}

/** One past session holding a user message, in the workspace the test names. */
const seedSession = async (root: string, cwd: string, text: string): Promise<string> => {
  const store = jsonlSessions({ root })
  const opened = await Effect.runPromise(
    store.create({ formatVersion: SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd }),
  )
  await Effect.runPromise(
    opened.sink.append({
      seq: 2,
      time: Date.now(),
      type: 'user/message',
      data: { text, source: 'user' },
    }),
  )
  return opened.id
}

/** Every tool result the run left in its log, as the model read them. */
const toolResultsOf = async (root: string): Promise<ReadonlyArray<string>> => {
  const store = jsonlSessions({ root })
  const listed = await Effect.runPromise(store.list())
  const results: Array<string> = []
  for (const summary of listed) {
    const opened = await Effect.runPromise(store.open(summary.id))
    for (const event of opened.events) {
      if (event.type === 'tool/result') results.push(JSON.stringify(event.data))
    }
  }
  return results
}

describe('the session-search row', () => {
  test('adds the session tools to the tools only when the row is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-session-search-'))
    try {
      const code = await run(root, root, 'enabled', [textTurn('ok')])
      expect(code).toBe(0)
      expect(await toolsOfFirstSession(root)).toEqual(
        expect.arrayContaining(['session_search', 'session_trace', 'session_event_read']),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the session tools out when the row is disabled or absent', async () => {
    for (const row of ['disabled', 'absent'] as const) {
      const root = await mkdtemp(join(tmpdir(), 'jozo-harness-session-search-off-'))
      try {
        const code = await run(root, root, row, [textTurn('ok')])
        expect(code).toBe(0)
        const names = await toolsOfFirstSession(root)
        expect(names).not.toContain('session_search')
        expect(names).not.toContain('session_trace')
        expect(names).not.toContain('session_event_read')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test('answers only from the workspace the run is in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-session-search-run-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-session-search-here-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'jozo-harness-session-search-there-'))
    try {
      const here = await seedSession(root, workspace, 'the needle is in this workspace')
      const there = await seedSession(root, elsewhere, 'the needle is in another workspace')

      const code = await run(root, workspace, 'enabled', [searchTurn('needle'), textTurn('done')])
      expect(code).toBe(0)

      const results = await toolResultsOf(root)
      const answer = results.join('\n')
      expect(answer).toContain(here)
      // The index marks the matched word, so the sentence is checked without it.
      expect(answer).toContain('is in this workspace')
      expect(answer).not.toContain(there)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  test('traces and reads a session that ran in this workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-session-trace-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-session-trace-here-'))
    try {
      const here = await seedSession(root, workspace, 'the needle is in this workspace')

      const code = await run(root, workspace, 'enabled', [
        callTurn('session_trace', { sessionId: here }, 'c1'),
        callTurn('session_event_read', { sessionId: here, seq: 2 }, 'c2'),
        textTurn('done'),
      ])
      expect(code).toBe(0)

      const results = await toolResultsOf(root)
      expect(results).toHaveLength(2)
      // The trace names the event and shows its first line; the read opens the
      // same event in full, marked as the target of the window.
      expect(results[0]).toContain('seq 2 user/message: the needle is in this workspace')
      expect(results[1]).toContain('> seq 2 user/message')
      expect(results[1]).toContain('the needle is in this workspace')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
