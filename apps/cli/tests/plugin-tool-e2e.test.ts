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
import { mcpPlugin, tier1Plugin } from '@jozo-harness/tools-tier1'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

const run = async (
  scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>,
  answer: string,
): Promise<{
  readonly code: number
  readonly settings: string
  readonly printed: string
  readonly results: string
}> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-plugin-'))
  const home = await mkdtemp(join(tmpdir(), 'jozo-harness-plugin-home-'))
  const settingsPath = join(home, 'config.yaml')
  const printed: Array<string> = []

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
        mcpPlugin,
        stubLlm(scripts),
        agentPlugin,
        agentLoopPlugin,
      ] as ReadonlyArray<Plugin<any, any, any>>,
      cwd: '/tmp',
      route: 'stub/model',
      task: 'manage the plugins',
      settingsPath,
      answer: () => Effect.succeed(answer),
      stdout: (text) => {
        printed.push(text)
      },
      stderr: () => undefined,
    }),
  )

  const settings = await readFile(settingsPath, 'utf8').catch(() => '')
  const listed = await Effect.runPromise(jsonlSessions({ root }).list())
  const opened = await Effect.runPromise(jsonlSessions({ root }).open(listed[0]?.id ?? ''))
  const results = opened.events
    .flatMap((event) => (event.type === 'tool/result' ? [JSON.stringify(event.data.content)] : []))
    .join('\n')
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  return { code, settings, printed: printed.join(''), results }
}

describe('the plugin rows through the command', () => {
  test('an approved row lands in the settings for the next start', async () => {
    const observed = await run(
      [
        toolTurn('plugin', { action: 'add', id: 'tier1', name: '@jozo-harness/tools-tier1' }),
        toolTurn('plugin', { action: 'list' }),
      ],
      'approve',
    )

    expect(observed.code).toBe(0)
    expect(observed.settings).toContain('id: tier1')
    expect(observed.settings).toContain('@jozo-harness/tools-tier1')
    // The answer says when it takes effect, and this run's rows are unchanged.
    expect(observed.results).toContain('starts again')
    expect(observed.results).toContain('kernel @jozo-harness/kernel')
  })

  test('a row the next start could not load is refused, and nothing is written', async () => {
    const observed = await run(
      [toolTurn('plugin', { action: 'add', id: 'mcp', name: '@jozo-harness/mcp' })],
      'approve',
    )

    expect(observed.code).toBe(0)
    // The next start would fail on that row: it is refused before the write, and
    // the model reads what the row still needs.
    expect(observed.settings).toBe('')
    expect(observed.results).toContain('command')
  })

  test('a row the human keeps changes nothing', async () => {
    const observed = await run(
      [toolTurn('plugin', { action: 'add', id: 'tier1', name: '@jozo-harness/tools-tier1' })],
      'keep the rows as they are',
    )

    expect(observed.code).toBe(0)
    expect(observed.settings).toBe('')
    expect(observed.results).toContain('kept the plugin rows as they are')
  })
})
