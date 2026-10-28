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
import { tier1Plugin, workspaceDependenciesPlugin } from '@jozo-harness/tools-tier1'
import { Effect, Layer, Schema, Stream } from 'effect'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const callTurn = (name: string, args: unknown, id: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const stubLlm = (scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>): Plugin<{}, Llm, never> => {
  let call = 0
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
          const script = scripts[call] ?? []
          call += 1
          return Stream.fromIterable(script)
        },
      } satisfies LlmAdapter),
  }
}

const python = 'dependencies/python/bin/python3'

/** A payload directory holding one runnable python, or a directory with no manifest. */
const payload = async (withManifest: boolean): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-runtimes-e2e-'))
  if (!withManifest) return root
  const path = join(root, python)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '#!/bin/sh\necho bundled-python "$@"\n')
  await chmod(path, 0o755)
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ python }))
  return root
}

/** The shipping profile with the workspace-dependencies row in the state a test needs. */
const profile = (root: string, dir: string, row: 'enabled' | 'absent'): string =>
  [
    'name: workspace-dependencies',
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
    '  - id: tier0',
    "    name: '@jozo-harness/tools-tier0'",
    '  - id: tier1',
    "    name: '@jozo-harness/tools-tier1'",
    ...(row === 'absent'
      ? []
      : [
          '  - id: workspace-dependencies',
          "    name: '@jozo-harness/workspace-dependencies'",
          '    config:',
          "      dir: '" + dir + "'",
        ]),
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const pluginsWith = (llm: Plugin<{}, Llm, never>): ReadonlyArray<Plugin<any, any, any>> => [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  safetyPlugin,
  askPlugin,
  tier0Plugin,
  tier1Plugin,
  workspaceDependenciesPlugin,
  llm,
  agentPlugin,
  agentLoopPlugin,
]

const run = (
  root: string,
  dir: string,
  row: 'enabled' | 'absent',
  scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>,
) =>
  Effect.runPromise(
    runCommand({
      profiles: [profile(root, dir, row)],
      plugins: pluginsWith(stubLlm(scripts)),
      cwd: root,
      route: 'stub/model',
      task: 'use the bundled runtimes',
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  )

/** The tool names the run recorded in the composition of its first session. */
const toolsOfFirstSession = async (root: string): Promise<ReadonlyArray<string>> => {
  const store = jsonlSessions({ root })
  const listed = await Effect.runPromise(store.list())
  const opened = await Effect.runPromise(store.open(listed[0]?.id ?? ''))
  return (
    opened.events.flatMap((event) =>
      event.type === 'preset/selected' ? [event.data.tools] : [],
    )[0] ?? []
  )
}

/** Every tool result the run left in its log, as the model read it. */
const toolResultsOf = async (
  root: string,
): Promise<ReadonlyArray<{ isError: boolean; text: string }>> => {
  const store = jsonlSessions({ root })
  const listed = await Effect.runPromise(store.list())
  const results: Array<{ isError: boolean; text: string }> = []
  for (const summary of listed) {
    const opened = await Effect.runPromise(store.open(summary.id))
    for (const event of opened.events) {
      if (event.type === 'tool/result') {
        const text = event.data.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
        results.push({ isError: event.data.isError, text })
      }
    }
  }
  return results
}

describe('the workspace-dependencies row', () => {
  test('hands the model the absolute paths of the payload the row names', async () => {
    const root = await payload(true)
    try {
      const code = await run(root, root, 'enabled', [
        callTurn('workspace_dependencies', {}, 'c1'),
        textTurn('done'),
      ])
      expect(code).toBe(0)
      expect(await toolsOfFirstSession(root)).toContain('workspace_dependencies')

      const results = await toolResultsOf(root)
      expect(results).toHaveLength(1)
      expect(results[0]?.isError).toBe(false)
      expect(results[0]?.text).toContain(join(root, python))
      expect(results[0]?.text).toContain('"missing"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the tool out when the row is absent', async () => {
    const root = await payload(true)
    try {
      const code = await run(root, root, 'absent', [textTurn('done')])
      expect(code).toBe(0)
      expect(await toolsOfFirstSession(root)).not.toContain('workspace_dependencies')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('tells the model the payload is missing instead of failing the turn', async () => {
    const root = await payload(false)
    try {
      const code = await run(root, root, 'enabled', [
        callTurn('workspace_dependencies', {}, 'c1'),
        textTurn('done'),
      ])
      expect(code).toBe(0)

      const results = await toolResultsOf(root)
      expect(results[0]?.isError).toBe(true)
      expect(results[0]?.text).toContain('runtime.json')
      expect(results[0]?.text).toContain('workspace_dependencies is unavailable')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
