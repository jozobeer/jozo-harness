import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { tier1Plugin } from '@jozo-harness/tools-tier1'
import { toolsPlugin } from '@jozo-harness/tools'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const callSubagent: ReadonlyArray<StreamChunk> = [
  {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: 'c1',
      name: 'subagent',
      arguments: JSON.stringify({ task: 'count the files' }),
    },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

/** First the parent calls subagent, then the child answers, then the parent wraps up. */
const stubLlm: Plugin<{}, Llm, never> = {
  name: 'stub-llm',
  config: Schema.Struct({}),
  provides: [Llm],
  requires: [],
  layer: () => {
    let call = 0
    return Layer.succeed(Llm, {
      name: 'stub',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      stream: () => {
        const scripts = [callSubagent, textTurn('child done'), textTurn('parent done')]
        const script = scripts[call] ?? []
        call += 1
        return Stream.fromIterable(script)
      },
    } satisfies LlmAdapter)
  },
}

const profile = (root: string): string =>
  [
    'name: test',
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
    '      preset: full',
    '  - id: ask',
    "    name: '@jozo-harness/ask'",
    '  - id: tier1',
    "    name: '@jozo-harness/tools-tier1'",
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

describe('subagent through the command', () => {
  test('the child runs its own session and the parent gets its answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-sub-'))

    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(root)],
        plugins: [
          kernelPlugin,
          sessionJsonlPlugin,
          sessionPlugin,
          toolsPlugin,
          systemPromptPlugin,
          safetyPlugin,
          askPlugin,
          tier1Plugin,
          stubLlm,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'delegate this',
        subagents: true,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    expect(sessions).toHaveLength(2)

    const opened = await Promise.all(
      sessions.map((summary) => Effect.runPromise(jsonlSessions({ root }).open(summary.id))),
    )
    const texts = opened.flatMap((session) =>
      session.events.flatMap((event) =>
        event.type === 'assistant/message'
          ? event.data.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : [],
      ),
    )
    const result = opened
      .flatMap((session) => session.events)
      .find((event) => event.type === 'tool/result')

    expect(texts).toContain('child done')
    expect(JSON.stringify(result)).toContain('child done')

    // The depth-limited child is told to do the work itself; the root is not.
    const snapshots = (events: (typeof opened)[number]['events']): ReadonlyArray<string> =>
      events.flatMap((event) =>
        event.type === 'user/message' &&
        (event.data as { source?: string }).source === 'runtime-context'
          ? [(event.data as { text: string }).text]
          : [],
      )
    const answers = (session: (typeof opened)[number]): ReadonlyArray<string> =>
      session.events.flatMap((event) =>
        event.type === 'assistant/message'
          ? event.data.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : [],
      )
    const child = opened.find((session) => answers(session).includes('child done'))
    const parent = opened.find((session) => session !== child)
    expect(snapshots(child?.events ?? []).join('\n')).toContain(
      'Delegation depth for subagent: current 1, maximum 1',
    )
    expect(snapshots(parent?.events ?? []).join('\n')).not.toContain('Delegation depth')

    await rm(root, { recursive: true, force: true })
  })
})
