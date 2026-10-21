import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { tier1Plugin } from '@jozo-harness/tools-tier1'
import { toolsPlugin } from '@jozo-harness/tools'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const toolTurn = (name: string, args: unknown): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'c-' + name, name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const profile = (root: string, planMode: boolean): string =>
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
    '      planMode: ' + String(planMode),
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

const run = async (planMode: boolean) => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-plan-'))
  const offered: Array<string> = []
  const stub: Plugin<{}, Llm, never> = {
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
          for (const schema of request.tools ?? []) offered.push(schema.name)
          return Stream.fromIterable(textTurn('ok'))
        },
      } satisfies LlmAdapter),
  }

  const code = await Effect.runPromise(
    runCommand({
      profiles: [profile(root, planMode)],
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
        stub,
        agentPlugin,
        agentLoopPlugin,
      ] as ReadonlyArray<Plugin<any, any, any>>,
      cwd: '/tmp',
      route: 'stub/model',
      task: 'plan something',
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  )
  await rm(root, { recursive: true, force: true })
  return { code, offered }
}

describe('plan mode through the command', () => {
  test('the model is offered only the read-only tools', async () => {
    const observed = await run(true)

    expect(observed.code).toBe(0)
    expect(observed.offered).toContain('read')
    expect(observed.offered).toContain('todo_write')
    expect(observed.offered).not.toContain('write')
    expect(observed.offered).not.toContain('bash')
    expect(observed.offered).not.toContain('edit')
  })

  test('without plan mode every tool is offered', async () => {
    const observed = await run(false)

    expect(observed.offered).toContain('write')
    expect(observed.offered).toContain('bash')
  })

  test('an approved plan brings the workspace tools back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-plan-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-plan-ws-'))
    const offered: Array<ReadonlyArray<string>> = []
    let step = 0
    const stub: Plugin<{}, Llm, never> = {
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
            offered.push((request.tools ?? []).map((schema) => schema.name))
            step += 1
            if (step === 1) {
              return Stream.fromIterable(
                toolTurn('exit_plan_mode', { plan: '1. write out.txt with the answer' }),
              )
            }
            if (step === 2) {
              return Stream.fromIterable(
                toolTurn('write', { path: 'out.txt', content: 'the answer\n' }),
              )
            }
            return Stream.fromIterable(textTurn('done'))
          },
        } satisfies LlmAdapter),
    }

    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(root, true)],
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
          stub,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: workspace,
        route: 'stub/model',
        task: 'plan, then do it',
        answer: () => Effect.succeed('approve'),
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )

    // While the plan is still a plan, the model cannot write.
    expect(offered[0]).not.toContain('write')
    expect(offered[0]).toContain('exit_plan_mode')
    // The approval ends plan mode, and the very next call could write.
    expect(code).toBe(0)
    expect(offered[1]).toContain('write')
    expect(await readFile(join(workspace, 'out.txt'), 'utf8')).toBe('the answer\n')

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  test('a resume after an approved plan starts with the workspace tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-plan-'))
    const offered: Array<ReadonlyArray<string>> = []
    let step = 0
    const stub: Plugin<{}, Llm, never> = {
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
            offered.push((request.tools ?? []).map((schema) => schema.name))
            step += 1
            return Stream.fromIterable(
              step === 1
                ? toolTurn('exit_plan_mode', { plan: '1. write out.txt' })
                : textTurn('done'),
            )
          },
        } satisfies LlmAdapter),
    }
    const plugins = [
      kernelPlugin,
      sessionJsonlPlugin,
      sessionPlugin,
      toolsPlugin,
      systemPromptPlugin,
      safetyPlugin,
      askPlugin,
      tier0Plugin,
      tier1Plugin,
      stub,
      agentPlugin,
      agentLoopPlugin,
    ] as ReadonlyArray<Plugin<any, any, any>>
    const runOnce = (options: { readonly task: string; readonly resume?: string }) =>
      Effect.runPromise(
        runCommand({
          profiles: [profile(root, true)],
          plugins,
          cwd: '/tmp',
          route: 'stub/model',
          task: options.task,
          answer: () => Effect.succeed('approve'),
          ...(options.resume === undefined ? {} : { resume: options.resume }),
          stdout: () => undefined,
          stderr: () => undefined,
        }),
      )

    // First run: plan mode ends with an approval, then the process exits.
    expect(await runOnce({ task: 'plan, then do it' })).toBe(0)
    const listed = await Effect.runPromise(jsonlSessions({ root }).list())
    const id = listed[0]?.id ?? ''
    const firstOffered = offered.length

    // A resumed run has the approved plan behind it, so the workspace tools are
    // offered from its very first request.
    expect(await runOnce({ task: 'carry on', resume: id })).toBe(0)
    expect(offered[firstOffered]).toContain('write')
    expect(offered[firstOffered]).not.toContain('exit_plan_mode')

    const opened = await Effect.runPromise(jsonlSessions({ root }).open(id))
    const modes = opened.events.flatMap((event) =>
      event.type === 'plan/mode' ? [event.data.mode] : [],
    )
    expect(modes).toEqual(['execute'])

    await rm(root, { recursive: true, force: true })
  })
})
