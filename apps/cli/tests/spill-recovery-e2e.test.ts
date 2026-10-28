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
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const TAIL = 'SPILL-TAIL-MARKER-4711'
/** 400 lines of 99 characters, so the file is over the 32 KB spill price. */
const BIG_TEXT = 'z'.repeat(98) + '\n'

const callTool = (name: string, args: unknown): ReadonlyArray<StreamChunk> => [
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

const seenText = (request: {
  readonly messages: ReadonlyArray<{
    readonly content: ReadonlyArray<{ type: string; text?: string }>
  }>
}): string =>
  request.messages
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n')

/** Answers like a model that reads the spill notice and goes back for the rest. */
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
          if (call === 1) return Stream.fromIterable(callTool('bash', { command: 'cat .big.txt' }))
          if (call === 2) {
            const path =
              /… middle omitted \(\d+ bytes\); read ([^\n]+)/.exec(text)?.[1] ?? 'missing'
            return Stream.fromIterable(callTool('read', { path, offset: 396, limit: 5 }))
          }
          if (call === 3) return Stream.fromIterable(callTool('read', { path: '.big.txt' }))
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
    // This test watches a spilled result, not the sandbox.
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

describe('recovering a spilled result', () => {
  test('the notice leads the model back to the text, and a read of it stays inline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jzh-spill-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-home-'))
    await writeFileDeep(join(workspace, '.big.txt'), BIG_TEXT.repeat(399) + TAIL + '\n')
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
        task: 'dump the file',
        jzhHome: home,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    // The spilled text lives under the session that owns it, in a private directory.
    const listed = await Effect.runPromise(jsonlSessions({ root }).list())
    const id = listed[0]?.id ?? ''
    const spill = join(home, 'spill', id)
    const files = await readdir(spill)
    expect(files).toHaveLength(1)
    expect((await readFile(join(spill, files[0] ?? ''), 'utf8')).length).toBeGreaterThan(32_000)
    expect((await stat(spill)).mode & 0o777).toBe(0o700)

    // Step 2 read the spilled file where the notice said it was, and step 4 saw the tail.
    expect(seen[3]).toContain(TAIL)

    // Reading the whole file is the way back, so that result is kept inline.
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(id))
    const results = opened.events.flatMap((event) =>
      event.type === 'tool/result' ? [event.data] : [],
    )
    const last = results[results.length - 1]
    expect(last?.isError).toBe(false)
    expect(JSON.stringify(last?.content)).not.toContain('middle omitted')
    expect(JSON.stringify(last?.content)).toContain(TAIL)

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })
})
