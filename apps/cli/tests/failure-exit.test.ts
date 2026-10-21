import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, LlmFailure, type LlmAdapter } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const failing: Plugin<{}, Llm, never> = {
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
      stream: () =>
        Stream.fail(new LlmFailure({ code: 'AUTH', message: 'no API key is configured' })),
    } satisfies LlmAdapter),
}

const profile = (root: string, retry = false): string =>
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
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
    ...(retry
      ? [
          '    config:',
          '      retry:',
          '        maxRetries: 1',
          '        initialDelayMs: 0',
          '        jitterRatio: 0',
        ]
      : []),
  ].join('\n')

describe('a turn that fails', () => {
  test('is reported on stderr and exits 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-fail-'))
    const err: Array<string> = []

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
          failing,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'say something',
        stdout: () => undefined,
        stderr: (text) => void err.push(text),
      }),
    )

    expect({ code, stderr: err.join('') }).toEqual({
      code: 1,
      stderr: 'jzh: the turn failed: AUTH: no API key is configured\n',
    })
    await rm(root, { recursive: true, force: true })
  })

  test('a completed turn still exits 0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-ok-'))
    const ok: Plugin<{}, Llm, never> = {
      ...failing,
      layer: () =>
        Layer.succeed(Llm, {
          name: 'stub',
          capabilities: {
            toolChoice: false,
            reasoningEffort: null,
            images: 'none',
            promptCacheControl: false,
          },
          stream: () =>
            Stream.fromIterable([
              { type: 'text-delta' as const, index: 0, text: 'fine' },
              {
                type: 'block-end' as const,
                index: 0,
                block: { type: 'text' as const, text: 'fine' },
              },
              { type: 'finish' as const, kind: 'stop' as const },
            ]),
        } satisfies LlmAdapter),
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
          ok,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'say something',
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )

    expect(code).toBe(0)
    await rm(root, { recursive: true, force: true })
  })

  test('a rate-limited attempt is retried by the loop row and the turn completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-retry-'))
    const err: Array<string> = []
    let calls = 0
    const flaky: Plugin<{}, Llm, never> = {
      ...failing,
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
            calls += 1
            return calls === 1
              ? Stream.fail(new LlmFailure({ code: 'RATE_LIMIT', message: 'slow down' }))
              : Stream.fromIterable([
                  { type: 'text-delta' as const, index: 0, text: 'fine' },
                  {
                    type: 'block-end' as const,
                    index: 0,
                    block: { type: 'text' as const, text: 'fine' },
                  },
                  { type: 'finish' as const, kind: 'stop' as const },
                ])
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
          flaky,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'say something',
        stdout: () => undefined,
        stderr: (text) => void err.push(text),
      }),
    )

    const store = jsonlSessions({ root })
    const sessions = await Effect.runPromise(store.list())
    const opened = await Effect.runPromise(store.open(sessions[0]?.id ?? ''))
    const retries = opened.events.flatMap((event) =>
      event.type === 'llm/retry' ? [event.data] : [],
    )
    const started = opened.events.flatMap((event) =>
      event.type === 'llm/retry-started' ? [event.data] : [],
    )

    expect({ code, stderr: err.join(''), calls }).toEqual({ code: 0, stderr: '', calls: 2 })
    expect(retries).toMatchObject([
      { attempt: 1, code: 'RATE_LIMIT', delayMs: 0, cause: 'transient' },
    ])
    expect(started).toEqual([{ retryId: retries[0]?.retryId }])
    await rm(root, { recursive: true, force: true })
  })
})
