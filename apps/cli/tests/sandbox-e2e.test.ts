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
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { spawn } from '@jozo-harness/process'
import { runCommand } from '../src/index.ts'

/** A host that cannot apply a sandbox refuses every command it is wrapped in. */
const sandboxApplies = async (): Promise<boolean> => {
  const probe = spawn(['sandbox-exec', '-p', '(version 1)(allow default)', '--', 'true'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await probe.exited) === 0
}

const applies = await sandboxApplies()

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const bashTurn = (command: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: 'c-bash',
      name: 'bash',
      arguments: JSON.stringify({ command }),
    },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const stubLlm = (command: string): Plugin<{}, Llm, never> => {
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
          const script = step === 0 ? bashTurn(command) : textTurn('done')
          step += 1
          return Stream.fromIterable(script)
        },
      } satisfies LlmAdapter),
  }
}

const profile = (root: string, workspace: string): string =>
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
    // A confining mode: `full` runs commands with no sandbox at all, which is
    // the other half of what this file watches.
    '      preset: workspace-write',
    '      writableRoots:',
    '        - ' + workspace,
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

/** Runs one bash call through the command with whatever sandbox the profile gets. */
const runBash = async (command: string, workspace: string) => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-sandbox-'))
  const code = await Effect.runPromise(
    runCommand({
      profiles: [profile(root, workspace)],
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
        stubLlm(command),
        agentPlugin,
        agentLoopPlugin,
      ] as ReadonlyArray<Plugin<any, any, any>>,
      cwd: workspace,
      route: 'stub/model',
      task: 'run it',
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  )
  const listed = await Effect.runPromise(jsonlSessions({ root }).list())
  const opened = await Effect.runPromise(jsonlSessions({ root }).open(listed[0]?.id ?? ''))
  const results = opened.events.flatMap((event) =>
    event.type === 'tool/result'
      ? [
          {
            text: JSON.stringify(event.data.content),
            isError: event.data.isError === true,
          },
        ]
      : [],
  )
  await rm(root, { recursive: true, force: true })
  return { code, results }
}

describe('the sandbox a profile did not ask for', () => {
  test.skipIf(!applies)('keeps a command inside its workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ws-'))
    const outside = resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '.sandbox-probe-' + String(process.pid),
    )
    const observed = await runBash(
      'echo in > in.txt; echo out > ' + outside + '; echo done',
      workspace,
    )

    try {
      expect(observed.code).toBe(0)
      // Inside the workspace: written.
      expect(existsSync(join(workspace, 'in.txt'))).toBe(true)
      // Outside it: the sandbox said no, so nothing was written.
      expect(existsSync(outside)).toBe(false)
    } finally {
      await rm(outside, { force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test.skipIf(!applies)('lets a command read the home directory and write /dev/null', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ws-'))
    const observed = await runBash(
      'test -r "$HOME" && echo home-readable; echo probe > /dev/null && echo null-writable',
      workspace,
    )

    try {
      expect(observed.code).toBe(0)
      expect(observed.results[0]?.isError).toBe(false)
      expect(observed.results[0]?.text).toContain('home-readable')
      expect(observed.results[0]?.text).toContain('null-writable')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test.skipIf(applies)('reports a sandbox the host refuses as a result, not a crash', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ws-'))
    const observed = await runBash('echo hi', workspace)

    expect(observed.code).toBe(0)
    expect(observed.results).toHaveLength(1)
    // The call itself is not an error: the sandbox's refusal is what the command left behind.
    expect(observed.results[0]?.isError).toBe(false)
    expect(observed.results[0]?.text).toContain('sandbox')

    await rm(workspace, { recursive: true, force: true })
  })
})
