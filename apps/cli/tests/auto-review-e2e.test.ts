import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type LlmRequest, type StreamChunk } from '@jozo-harness/llm'
import { safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { toolsPlugin } from '@jozo-harness/tools'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const MARKER = 'marker.txt'

const callBash: ReadonlyArray<StreamChunk> = [
  {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: 'c1',
      name: 'bash',
      arguments: JSON.stringify({ command: 'echo ran > ' + MARKER }),
    },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

/** The line the review prompt opens with; the stub answers only that call. */
const REVIEW_OPENING = 'You review one tool call'

/** A model that follows the tool script and answers review calls with one verdict. */
const stubWithReview = (
  verdict: string,
): { readonly plugin: Plugin<{}, Llm, never>; readonly reviews: Array<LlmRequest> } => {
  const reviews: Array<LlmRequest> = []
  const plugin: Plugin<{}, Llm, never> = {
    name: 'stub-llm',
    config: Schema.Struct({}),
    provides: [Llm],
    requires: [],
    layer: () => {
      let call = 0
      return Layer.succeed(Llm, {
        name: 'stub',
        capabilities: {
          toolChoice: false,
          reasoningEffort: null,
          images: 'none',
          promptCacheControl: false,
        },
        stream: (request) => {
          const prompt = request.messages
            .flatMap((message) => message.content)
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('\n')
          // A review call carries no tools; the loop always offers the tier 0 set.
          if (request.tools !== undefined && request.tools.length === 0) {
            reviews.push(request)
            return Stream.fromIterable(
              textTurn(prompt.includes(REVIEW_OPENING) ? verdict : 'ALLOW'),
            )
          }
          const scripts = [callBash, textTurn('all done')]
          const script = scripts[call] ?? []
          call += 1
          return Stream.fromIterable(script)
        },
      } satisfies LlmAdapter)
    },
  }
  return { plugin, reviews }
}

const profile = (root: string, preset: string): string =>
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
    '      preset: ' + preset,
    // These tests watch the review and the call, not the sandbox; a confined run
    // would fail the write before either question could be asked.
    '      sandbox: none',
    '  - id: tier0',
    "    name: '@jozo-harness/tools-tier0'",
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const run = async (preset: string, verdict: string) => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-auto-'))
  const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-auto-ws-'))
  const stub = stubWithReview(verdict)
  const code = await Effect.runPromise(
    runCommand({
      profiles: [profile(root, preset)],
      plugins: [
        kernelPlugin,
        sessionJsonlPlugin,
        sessionPlugin,
        toolsPlugin,
        systemPromptPlugin,
        safetyPlugin,
        tier0Plugin,
        stub.plugin,
        agentPlugin,
        agentLoopPlugin,
      ] as ReadonlyArray<Plugin<any, any, any>>,
      cwd: workspace,
      route: 'stub/model',
      task: 'run the command',
      approve: () => Effect.succeed(false),
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  )
  const wrote = await stat(join(workspace, MARKER)).then(
    () => true,
    () => false,
  )
  const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
  const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
  await rm(root, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
  return { code, events: opened.events, wrote, reviews: stub.reviews }
}

describe('auto review through the command', () => {
  test('denies the call the reviewer refused and records why', async () => {
    const observed = await run('auto', 'DENY: it would delete the repository')
    const result = observed.events.find((event) => event.type === 'tool/result')
    const reviewed = observed.events.filter((event) => event.type === 'safety/auto/reviewed')
    const denial = reviewed[0]

    expect(observed.code).toBe(0)
    expect(observed.reviews).toHaveLength(1)
    expect(observed.wrote).toBe(false)
    expect(result?.type === 'tool/result' ? result.data.isError : false).toBe(true)
    expect(denial?.type === 'safety/auto/reviewed' ? denial.data.decision : '').toBe('denied')
    expect(denial?.type === 'safety/auto/reviewed' ? denial.data.reason : '').toContain('delete')
  })

  test('runs the call the reviewer allowed', async () => {
    const observed = await run('auto', 'ALLOW')
    const result = observed.events.find((event) => event.type === 'tool/result')

    expect(observed.reviews).toHaveLength(1)
    expect(observed.wrote).toBe(true)
    expect(result?.type === 'tool/result' ? result.data.isError : true).toBe(false)
  })

  test('never asks a reviewer under another preset', async () => {
    for (const preset of ['read-only', 'workspace-write', 'full']) {
      const observed = await run(preset, 'DENY: never asked')
      expect(observed.reviews).toHaveLength(0)
      expect(observed.wrote).toBe(true)
      expect(observed.events.some((event) => event.type === 'safety/auto/reviewed')).toBe(false)
    }
  })
})
