import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
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
import { runCommand, type CommandOptions } from '../src/index.ts'

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

const stubLlm = (scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>): Plugin<{}, Llm, never> => {
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
          const script = scripts[step] ?? textTurn('done')
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

const run = (
  root: string,
  scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>,
  options: Partial<CommandOptions>,
): Promise<number> =>
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
        tier0Plugin,
        tier1Plugin,
        stubLlm(scripts),
        agentPlugin,
        agentLoopPlugin,
      ] as ReadonlyArray<Plugin<any, any, any>>,
      cwd: '/tmp',
      route: 'stub/model',
      stdout: () => undefined,
      stderr: () => undefined,
      schedulesPath: join(root, 'schedules.json'),
      ...options,
    }),
  )

describe('a standing schedule through the command', () => {
  test('is recorded, and one that came due while away brings the session back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-schedule-'))

    // First run: the model leaves a schedule behind and the run ends.
    const first = await run(
      root,
      [
        toolTurn('schedule', { action: 'create', every: 1, prompt: 'check the build' }),
        textTurn('done'),
      ],
      { task: 'leave a schedule' },
    )
    expect(first).toBe(0)

    // A moment later the schedule is overdue, so the next run fires it and the
    // model is brought back with the instruction, then clears it.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const second = await run(
      root,
      [toolTurn('schedule', { action: 'delete', id: 'sched-1' }), textTurn('done')],
      {
        task: 'carry on',
        resume: await firstSessionId(root),
      },
    )
    expect(second).toBe(0)

    const opened = await Effect.runPromise(jsonlSessions({ root }).open(await firstSessionId(root)))
    const events = opened.events
    const fired = events.flatMap((event) => (event.type === 'schedule/fired' ? [event.data] : []))
    const brought = events.flatMap((event) =>
      event.type === 'user/message' && event.data.source === 'schedule' ? [event.data.text] : [],
    )
    const standing = events.flatMap((event) =>
      event.type === 'schedule/created' ? [event.data.schedule.id] : [],
    )
    const deleted = events.flatMap((event) =>
      event.type === 'schedule/deleted' ? [event.data.id] : [],
    )

    expect(standing).toEqual(['sched-1'])
    expect(fired.length).toBeGreaterThan(0)
    expect(brought.join('\n')).toContain('<schedule id="sched-1"')
    expect(brought.join('\n')).toContain('check the build')
    expect(deleted).toEqual(['sched-1'])

    await rm(root, { recursive: true, force: true })
  })
})

const firstSessionId = async (root: string): Promise<string> => {
  const listed = await Effect.runPromise(jsonlSessions({ root }).list())
  return listed[0]?.id ?? ''
}
