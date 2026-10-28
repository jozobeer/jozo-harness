import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const MARKER = 'tail-marker'

const toolTurn = (command: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'c', name: 'bash', arguments: JSON.stringify({ command }) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const seenText = (request: {
  readonly messages: ReadonlyArray<{
    readonly content: ReadonlyArray<{ type: string; text?: string }>
  }>
}): string =>
  request.messages
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n')

/** A failing command first, then one whose output cannot fit in a message. */
const stubLlm = (seen: Array<string>): Plugin<{}, Llm, never> => {
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
        stream: (request) => {
          const text = seenText(request)
          seen.push(text)
          call += 1
          if (call === 1) return Stream.fromIterable(toolTurn('echo bad; exit 3'))
          if (call === 2) {
            return Stream.fromIterable(
              toolTurn('yes ' + 'x'.repeat(60) + ' | head -n 2000; echo ' + MARKER),
            )
          }
          if (call === 3) {
            const path =
              /… middle omitted \(\d+ bytes\); read ([^\n]+)/.exec(text)?.[1] ?? 'missing'
            return Stream.fromIterable(
              toolTurn('tail -n 2 ' + path.replace('/dev/null', '') + ' # read the spill tail'),
            )
          }
          return Stream.fromIterable(textTurn('done'))
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
    // This test watches bash itself, not the sandbox: run as they are.
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

describe('what a bash call leaves behind', () => {
  test('a failure is a result with its exit code, and a big output names its file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-bash-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-bash-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-bash-home-'))
    const seen: Array<string> = []

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
          tier0Plugin,
          stubLlm(seen),
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: workspace,
        route: 'stub/model',
        task: 'run the commands',
        jzhHome: home,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    const listed = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(listed[0]?.id ?? ''))
    const results = opened.events.flatMap((event) =>
      event.type === 'tool/result' ? [event.data] : [],
    )
    const failed = results[0]
    const huge = results[1]

    // The command failed; the call did not.
    expect(failed?.isError).toBe(false)
    expect(JSON.stringify(failed?.content)).toContain('[exit code: 3]')
    expect(seen[1]).toContain('[exit code: 3]')

    // The model was told where the rest of the output went.
    const notice = JSON.stringify(huge?.content ?? [])
    expect(notice).toContain('middle omitted')
    expect(notice).toContain('/spill/')
    // And it could go back for the part it could not see.
    expect(seen[3]).toContain(MARKER)

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })
})
