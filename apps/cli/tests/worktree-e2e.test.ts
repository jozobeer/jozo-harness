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
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const run = promisify(execFile)

const call = (name: string, args: unknown): ReadonlyArray<StreamChunk> => [
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

const stubLlm: Plugin<{}, Llm, never> = {
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
      stream: () => {
        const scripts = [
          call('create_worktree', { branch: 'side' }),
          call('bash', { command: 'pwd' }),
          textTurn('done'),
        ]
        const script = scripts[step] ?? []
        step += 1
        return Stream.fromIterable(script)
      },
    } satisfies LlmAdapter)
  },
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
    // This test watches the worktree move, not the sandbox.
    '      sandbox: none',
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

describe('create_worktree through the command', () => {
  test('the session continues in the worktree and the original checkout does not move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-worktree-cmd-'))
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'jozo-harness-ws-')))
    await run('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace })
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace })
    await writeFile(join(workspace, 'README.md'), 'base\n')
    await run('git', ['add', 'README.md'], { cwd: workspace })
    await run('git', ['commit', '-qm', 'base'], { cwd: workspace })
    const tree = join(dirname(workspace), basename(workspace) + '-side')

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
          stubLlm,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: workspace,
        route: 'stub/model',
        task: 'work in a worktree',
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
    const moved = opened.events.find((event) => event.type === 'session/cwd/changed')
    const results = opened.events.filter((event) => event.type === 'tool/result')

    expect(moved?.data).toEqual({ cwd: tree, root: tree })
    expect(results).toHaveLength(2)
    expect(JSON.stringify(results[1]?.data.content)).toContain(tree)
    expect(
      (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace })).stdout.trim(),
    ).toBe('main')
    expect((await run('git', ['status', '--porcelain'], { cwd: workspace })).stdout).toBe('')

    await run('git', ['worktree', 'remove', '--force', tree], { cwd: workspace })
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })
})
