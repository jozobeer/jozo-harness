import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type LlmRequest, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { tier1Plugin } from '@jozo-harness/tools-tier1'
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

const toolTurn = (name: string, args: unknown): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'c-' + name, name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const textOf = (request: LlmRequest): string =>
  request.messages
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')

const REPORT = JSON.stringify({
  status: 'complete',
  summary: 'wrote the note',
  evidence: ['notes.txt holds the note'],
  nextSteps: [],
})

/** Plays the parent: it calls ralph once, then answers when the report comes back. */
const stubLlm = (
  seen: Array<{ readonly tools: ReadonlyArray<string>; readonly text: string }>,
): Plugin<{}, Llm, never> => ({
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
      stream: (request) => {
        const text = textOf(request)
        seen.push({ tools: (request.tools ?? []).map((tool) => tool.name), text })
        // The worker gets its own objective and nothing from the parent's turn.
        if (text.includes('<ralph_round>')) return Stream.fromIterable(textTurn(REPORT))
        // The parent's next turn reads the tool result before it answers.
        if (text.includes('the worker reported complete')) {
          return Stream.fromIterable(textTurn('the worker is done'))
        }
        return Stream.fromIterable(toolTurn('ralph', { objective: 'write the note' }))
      },
    } satisfies LlmAdapter),
})

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
    '  - id: tier0',
    "    name: '@jozo-harness/tools-tier0'",
    '  - id: tier1',
    "    name: '@jozo-harness/tools-tier1'",
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const usersOf = (events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>) =>
  events.flatMap((event) =>
    event.type === 'user/message' && (event.data as { source: string }).source === 'user'
      ? [(event.data as { text: string }).text]
      : [],
  )

describe('the ralph tool through the command', () => {
  test('runs one fresh round without --subagents and hands back its report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-ralph-'))
    const seen: Array<{ readonly tools: ReadonlyArray<string>; readonly text: string }> = []
    const errs: Array<string> = []

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
          tier0Plugin,
          tier1Plugin,
          stubLlm(seen),
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'delegate one round to ralph',
        stdout: () => undefined,
        stderr: (text) => {
          errs.push(text)
        },
      }),
    )

    const store = jsonlSessions({ root })
    const sessions = await Effect.runPromise(store.list())
    const logs = await Promise.all(
      sessions.map((session) =>
        Effect.runPromise(store.open(session.id)).then((opened) => opened.events),
      ),
    )
    const child = logs.find((events) =>
      usersOf(events).some((text) => text.includes('<ralph_round>')),
    )
    const parent = logs.find((events) => events !== child)

    expect(errs.join('')).toBe('')
    expect(code).toBe(0)
    // The parent and the one fresh child it started.
    expect(sessions).toHaveLength(2)
    // ralph is a default tool: no --subagents flag was passed.
    expect(seen[0]?.tools).toContain('ralph')
    expect(seen[0]?.tools).not.toContain('subagent')
    expect(
      (parent ?? []).flatMap((event) =>
        event.type === 'preset/selected' ? [event.data.tools] : [],
      )[0],
    ).toContain('ralph')
    // The child got the objective and none of the parent's conversation.
    const childUsers = child === undefined ? [] : usersOf(child)
    expect(childUsers).toHaveLength(1)
    expect(childUsers[0]).toContain('Objective: write the note')
    expect(childUsers[0]).toContain('Round: 1/256')
    expect(childUsers[0]).not.toContain('delegate one round to ralph')
    // The parent read the worker's own report back.
    expect(seen.some((request) => request.text.includes('the worker reported complete'))).toBe(true)

    await rm(root, { recursive: true, force: true })
  })
})
