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

const callAsk: ReadonlyArray<StreamChunk> = [
  {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: 'c1',
      name: 'ask_user',
      arguments: JSON.stringify({ question: 'which colour?', options: ['blue', 'red'] }),
    },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const stubLlmFor = (
  scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>,
): Plugin<{}, Llm, never> => ({
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
        const script = scripts[call] ?? []
        call += 1
        return Stream.fromIterable(script)
      },
    } satisfies LlmAdapter)
  },
})

const stubLlm = stubLlmFor([callAsk, textTurn('thanks')])

const callBatch: ReadonlyArray<StreamChunk> = [
  {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: 'c1',
      name: 'ask_user',
      arguments: JSON.stringify({
        questions: [
          { id: 'colour', question: 'which colour?', options: ['blue', 'red'] },
          { id: 'size', question: 'which size?', options: ['small', 'large'] },
        ],
      }),
    },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const stubBatchLlm = stubLlmFor([callBatch, textTurn('done')])

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

describe('ask_user through the command', () => {
  test('the question and the answer land in the log in order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-ask-'))
    const asked: Array<string> = []

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
        task: 'ask me',
        answer: (request) =>
          Effect.sync(() => {
            asked.push(request.question)
            return 'blue'
          }),
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
    const types = opened.events.map((event) => event.type)
    const result = opened.events.find((event) => event.type === 'tool/result')

    expect(asked).toEqual(['which colour?'])
    expect(types.indexOf('interaction/ask/requested')).toBeGreaterThan(types.indexOf('tool/call'))
    expect(types.indexOf('interaction/ask/answered')).toBeGreaterThan(
      types.indexOf('interaction/ask/requested'),
    )
    expect(types.indexOf('tool/result')).toBeGreaterThan(types.indexOf('interaction/ask/answered'))
    expect(JSON.stringify(result)).toContain('blue')
    await rm(root, { recursive: true, force: true })
  })

  test('one call asks several questions and the log names the call with every answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-ask-batch-'))
    const asked: Array<string> = []

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
          stubBatchLlm,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'ask me two things',
        answer: (request) =>
          Effect.sync(() => {
            asked.push(request.question)
            return request.question === 'which colour?' ? 'blue' : 'large'
          }),
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
    const answers = opened.events.find((event) => event.type === 'interaction/ask/answers')
    const result = opened.events.find((event) => event.type === 'tool/result')

    expect(asked).toEqual(['which colour?', 'which size?'])
    expect(answers?.data).toEqual({
      callId: 'c1',
      answers: [
        { id: 'colour', selected: ['blue'] },
        { id: 'size', selected: ['large'] },
      ],
    })
    expect(JSON.stringify(result)).toContain('blue')
    expect(JSON.stringify(result)).toContain('large')
    await rm(root, { recursive: true, force: true })
  })

  test('a question with nobody to answer fails, not hangs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-ask-'))
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
        task: 'ask me',
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
    const result = opened.events.find((event) => event.type === 'tool/result')
    expect(JSON.stringify(result)).toContain('nobody is listening')
    await rm(root, { recursive: true, force: true })
  })
})
