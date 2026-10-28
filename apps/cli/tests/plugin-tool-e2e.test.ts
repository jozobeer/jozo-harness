import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin, type PluginRow } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { lspPlugin, mcpPlugin, tier1Plugin } from '@jozo-harness/tools-tier1'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const stubLlm = (
  scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>,
  observe?: (tools: ReadonlyArray<string>) => void,
): Plugin<{}, Llm, never> => {
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
        stream: (request) => {
          observe?.((request.tools ?? []).map((schema) => schema.name))
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
  observe?: (tools: ReadonlyArray<string>) => void,
  /** Rows the run starts with, as the settings file would hold them. */
  opening: { readonly rows?: ReadonlyArray<PluginRow>; readonly settings?: string } = {},
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
  if (opening.settings !== undefined) await writeFile(settingsPath, opening.settings)

  const code = await Effect.runPromise(
    runCommand({
      profiles: [profile(root)],
      ...(opening.rows === undefined ? {} : { extraRows: opening.rows }),
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
        lspPlugin,
        stubLlm(scripts, observe),
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

  test('an added opt-in row is wired before the next step', async () => {
    const offered: Array<ReadonlyArray<string>> = []
    const observed = await run(
      [
        toolTurn('plugin', { action: 'add', id: 'lsp', name: '@jozo-harness/lsp' }),
        textTurn('done'),
      ],
      'approve',
      (tools) => offered.push(tools),
    )

    expect(observed.code).toBe(0)
    expect(offered[0]).not.toContain('lsp')
    expect(offered[1]).toContain('lsp')
    expect(observed.settings).toContain('id: lsp')
    expect(observed.results).toContain('lsp is wired into this run now')
  })

  test('a row added and then removed leaves the next step with the tools it began with', async () => {
    const offered: Array<ReadonlyArray<string>> = []
    const observed = await run(
      [
        toolTurn('plugin', { action: 'add', id: 'lsp', name: '@jozo-harness/lsp' }),
        toolTurn('plugin', { action: 'remove', id: 'lsp' }),
        textTurn('done'),
      ],
      'approve',
      (tools) => offered.push(tools),
    )

    expect(observed.code).toBe(0)
    expect(offered[0]).not.toContain('lsp')
    expect(offered[1]).toContain('lsp')
    expect(offered[2]).not.toContain('lsp')
    expect(observed.settings).toBe('')
    expect(observed.results).toContain('no longer hold lsp')
  })

  test('a row taken back out can be added again', async () => {
    const offered: Array<ReadonlyArray<string>> = []
    const observed = await run(
      [
        toolTurn('plugin', { action: 'add', id: 'lsp', name: '@jozo-harness/lsp' }),
        toolTurn('plugin', { action: 'remove', id: 'lsp' }),
        toolTurn('plugin', { action: 'add', id: 'lsp', name: '@jozo-harness/lsp' }),
        textTurn('done'),
      ],
      'approve',
      (tools) => offered.push(tools),
    )

    expect(observed.code).toBe(0)
    expect(offered[1]).toContain('lsp')
    expect(offered[2]).not.toContain('lsp')
    expect(offered[3]).toContain('lsp')
    expect(observed.settings).toContain('id: lsp')
  })

  test('a row the run started with leaves the next step when the settings hold it', async () => {
    const offered: Array<ReadonlyArray<string>> = []
    const observed = await run(
      [toolTurn('plugin', { action: 'remove', id: 'lsp' }), textTurn('done')],
      'approve',
      (tools) => offered.push(tools),
      {
        rows: [{ id: 'lsp', name: '@jozo-harness/lsp' }],
        settings: "plugins:\n  - id: lsp\n    name: '@jozo-harness/lsp'\n",
      },
    )

    expect(observed.code).toBe(0)
    expect(offered[0]).toContain('lsp')
    expect(offered[1]).not.toContain('lsp')
    expect(observed.settings).toBe('')
  })

  test('removing an id this run does not hold is refused', async () => {
    const observed = await run([toolTurn('plugin', { action: 'remove', id: 'nowhere' })], 'approve')

    expect(observed.code).toBe(0)
    expect(observed.settings).toBe('')
    expect(observed.results).toContain('no row with that id: nowhere')
  })

  test('removing a row that carries config is refused and changes nothing', async () => {
    const observed = await run(
      [toolTurn('plugin', { action: 'remove', id: 'session-jsonl' })],
      'approve',
    )

    expect(observed.code).toBe(0)
    expect(observed.settings).toBe('')
    expect(observed.results).toContain('carries config')
  })

  test('a row that would add a second copy of a tool is refused and not written', async () => {
    const observed = await run(
      [
        toolTurn('plugin', { action: 'add', id: 'lsp', name: '@jozo-harness/lsp' }),
        toolTurn('plugin', { action: 'add', id: 'lsp-2', name: '@jozo-harness/lsp' }),
        textTurn('done'),
      ],
      'approve',
    )

    expect(observed.code).toBe(0)
    expect(observed.settings).toContain('id: lsp')
    expect(observed.settings).not.toContain('lsp-2')
    expect(observed.results).toContain('tool lsp is already registered')
  })
})
