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

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const runCodeTurn = (code: string, id = 'c1'): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id,
      name: 'run_code',
      arguments: JSON.stringify({ code }),
    },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const stub = (scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>): Plugin<{}, Llm, never> => {
  let step = 0
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
          const script = scripts[step] ?? []
          step += 1
          return Stream.fromIterable(script)
        },
      } satisfies LlmAdapter),
  }
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
    '      preset: workspace-write',
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

describe('run_code through the command', () => {
  test('a nested call and its result land in the session log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-run-code-'))
    const code =
      "const result = await tools.todo_write({ todos: [{ content: 'nested', status: 'completed' }] })\nreturn result.counts.completed"

    const outcome = await Effect.runPromise(
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
          stub([runCodeTurn(code), textTurn('all done')]),
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: root,
        route: 'stub/model',
        task: 'run a nested tool',
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(outcome).toBe(0)

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
    const call = opened.events.find((event) => event.type === 'tool/call')
    const callId = call?.type === 'tool/call' ? call.data.callId : ''
    const starts = opened.events.flatMap((event) =>
      event.type === 'tool/ptc-dispatch-start' ? [event.data] : [],
    )
    const settled = opened.events.flatMap((event) =>
      event.type === 'tool/ptc-dispatch' ? [event.data] : [],
    )

    expect(starts).toEqual([
      {
        callId: callId + '.1',
        name: 'todo_write',
        arguments: '{"todos":[{"content":"nested","status":"completed"}]}',
      },
    ])
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ callId: callId + '.1', name: 'todo_write', isError: false })
    expect(settled[0]?.summary).toContain('[x] nested')
    await rm(root, { recursive: true, force: true })
  })

  test('the second call reads what the first program left on globalThis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-run-code-memory-'))

    const outcome = await Effect.runPromise(
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
          stub([
            runCodeTurn('globalThis.total = 41', 'c1'),
            runCodeTurn('return globalThis.total + 1', 'c2'),
            textTurn('all done'),
          ]),
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: root,
        route: 'stub/model',
        task: 'keep a value between programs',
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(outcome).toBe(0)

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
    const results = opened.events.flatMap((event) =>
      event.type === 'tool/result' ? [event.data] : [],
    )
    const second = results[1]
    const text = (second?.content ?? [])
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')

    expect(results).toHaveLength(2)
    expect(second?.isError).toBe(false)
    expect(text).toContain('return: 42')
    await rm(root, { recursive: true, force: true })
  })

  test('a resumed run does not see what the closed run put on globalThis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-run-code-closed-'))
    const run = (
      task: string,
      scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>,
      resume?: string,
    ) =>
      Effect.runPromise(
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
            stub(scripts),
            agentPlugin,
            agentLoopPlugin,
          ] as ReadonlyArray<Plugin<any, any, any>>,
          cwd: root,
          route: 'stub/model',
          task,
          stdout: () => undefined,
          stderr: () => undefined,
          ...(resume === undefined ? {} : { resume }),
        }),
      )

    expect(
      await run('keep a value', [runCodeTurn('globalThis.total = 41'), textTurn('done')]),
    ).toBe(0)
    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const id = sessions[0]?.id ?? ''
    expect(
      await run(
        'read it again',
        [runCodeTurn('return typeof globalThis.total'), textTurn('done')],
        id,
      ),
    ).toBe(0)

    const opened = await Effect.runPromise(jsonlSessions({ root }).open(id))
    const results = opened.events.flatMap((event) =>
      event.type === 'tool/result' ? [event.data] : [],
    )
    const second = results[1]
    const text = (second?.content ?? [])
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')

    expect(results).toHaveLength(2)
    expect(text).toContain('return: "undefined"')
    await rm(root, { recursive: true, force: true })
  })
})
