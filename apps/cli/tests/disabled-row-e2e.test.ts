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
import { runCommand } from '../src/index.ts'

const reply = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const stubLlm = (): Plugin<{}, Llm, never> => ({
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
      stream: () => Stream.fromIterable(reply('ok')),
    } satisfies LlmAdapter),
})

/** The same profile with one row switched off, to see what a run does without it. */
const profile = (root: string, disabled: 'tier0' | 'tier1'): string =>
  [
    'name: disabled-row',
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
    ...(disabled === 'tier0' ? ['    disabled: true'] : []),
    '  - id: tier1',
    "    name: '@jozo-harness/tools-tier1'",
    ...(disabled === 'tier1' ? ['    disabled: true'] : []),
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const plugins: ReadonlyArray<Plugin<any, any, any>> = [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  safetyPlugin,
  askPlugin,
  tier0Plugin,
  tier1Plugin,
  stubLlm(),
  agentPlugin,
  agentLoopPlugin,
]

const run = (root: string, disabled: 'tier0' | 'tier1') => {
  const errs: Array<string> = []
  return Effect.runPromise(
    runCommand({
      profiles: [profile(root, disabled)],
      plugins,
      cwd: '/tmp',
      route: 'stub/model',
      task: 'hi',
      stdout: () => undefined,
      stderr: (text) => {
        errs.push(text)
      },
    }),
  ).then((code) => ({ code, stderr: errs.join('') }))
}

const toolsOfFirstSession = async (root: string): Promise<ReadonlyArray<string>> => {
  const sessions = jsonlSessions({ root })
  const listed = await Effect.runPromise(sessions.list())
  const id = listed[0]?.id ?? ''
  const opened = await Effect.runPromise(sessions.open(id))
  return (
    opened.events.flatMap((event) =>
      event.type === 'preset/selected' ? [event.data.tools] : [],
    )[0] ?? []
  )
}

describe('a disabled profile row', () => {
  test('starts the run instead of failing on a service the loader never built', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-disabled-tier0-'))
    try {
      const result = await run(root, 'tier0')
      expect(result.stderr).not.toContain('Service not found')
      expect(result.code).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('takes its tools out of the composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-disabled-tier1-'))
    try {
      const result = await run(root, 'tier1')
      expect(result.code).toBe(0)
      const tools = await toolsOfFirstSession(root)
      expect(tools).not.toContain('todo_write')
      expect(tools).not.toContain('run_code')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
