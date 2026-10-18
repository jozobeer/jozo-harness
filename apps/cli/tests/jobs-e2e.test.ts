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

const call = (index: number, name: string, args: unknown): StreamChunk => ({
  type: 'block-end',
  index,
  block: { type: 'tool-call', id: 'c-' + name, name, arguments: JSON.stringify(args) },
})

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

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

describe('background jobs through the command', () => {
  test('a started job is read back in a later step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-jobs-'))
    const stub: Plugin<{}, Llm, never> = {
      name: 'stub-llm',
      config: Schema.Struct({}),
      provides: [Llm],
      requires: [],
      layer: () => {
        let step = 0
        return Layer.succeed(Llm, {
          name: 'stub',
          capabilities: {
            toolChoice: false,
            reasoningEffort: null,
            images: 'none',
            promptCacheControl: false,
          },
          stream: (request) => {
            // The start result is the only place the id is written; a later step
            // reads it back from the history rather than guessing the counter.
            const startedId = /started (job-[0-9a-f]{8})/.exec(
              JSON.stringify(request.messages),
            )?.[1]
            const scripts: ReadonlyArray<ReadonlyArray<StreamChunk>> = [
              [call(0, 'job_start', { command: 'echo from the job; sleep 0.4' })],
              [call(0, 'job_output', { id: startedId ?? 'job-missing' })],
              textTurn('done'),
            ]
            const script = scripts[step] ?? []
            step += 1
            return Stream.fromIterable(script)
          },
        } satisfies LlmAdapter)
      },
    }

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
          stub,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'start a job and read it',
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
    const results = opened.events.filter((event) => event.type === 'tool/result')

    expect(results).toHaveLength(2)
    const startedId = /started (job-[0-9a-f]{8})/.exec(JSON.stringify(results[0]?.data))?.[1]
    expect(startedId).toBeDefined()
    // The job has been started and read back; its output may still be arriving.
    expect(results[1]?.data.isError).toBe(false)
    expect(JSON.stringify(results[1]?.data)).toContain('job')
    // The start is in the session log, so a resumed run can tell it from what it starts.
    const startedEvents = opened.events.filter((event) => event.type === 'job/started')
    expect(startedEvents).toHaveLength(1)
    expect(startedEvents[0]?.data).toMatchObject({
      id: startedId,
      command: 'echo from the job; sleep 0.4',
    })
    await rm(root, { recursive: true, force: true })
  })
})
