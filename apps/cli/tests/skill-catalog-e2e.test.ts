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
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const BODY_MARKER = 'SKILL-BODY-MARKER-8123'

const skillText = (name: string, description: string, body: string): string =>
  '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n' + body + '\n'

const callSkill = (name: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'c1', name: 'skill', arguments: JSON.stringify({ name }) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

/**
 * Every request the model made, as the text of the messages it received. `between`
 * runs before each answer, so a test can change the workspace mid-session.
 */
const stubLlm = (
  scripts: ReadonlyArray<ReadonlyArray<StreamChunk>>,
  seen: Array<string>,
  between?: () => void,
) => {
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
          seen.push(
            request.messages
              .flatMap((message) => message.content)
              .flatMap((block) => (block.type === 'text' ? [block.text] : []))
              .join('\n'),
          )
          between?.()
          const script = scripts[call] ?? []
          call += 1
          return Stream.fromIterable(script)
        },
      } satisfies LlmAdapter),
  } satisfies Plugin<{}, Llm, never>
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

const plugins = (llm: Plugin<{}, Llm, never>): ReadonlyArray<Plugin<any, any, any>> => [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  safetyPlugin,
  askPlugin,
  tier0Plugin,
  tier1Plugin,
  llm,
  agentPlugin,
  agentLoopPlugin,
]

describe('skills through the command', () => {
  test('the catalog names every root and the model reads the skill it matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skill-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-home-'))
    await writeFileDeep(
      join(workspace, '.jzh', 'skills', 'demo', 'SKILL.md'),
      skillText('demo', 'Explains how to greet', BODY_MARKER),
    )
    await writeFileDeep(
      join(home, 'skills', 'other', 'SKILL.md'),
      skillText('other', 'Does something else', 'other body'),
    )
    const seen: Array<string> = []

    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(root)],
        plugins: plugins(stubLlm([callSkill('demo'), textTurn('done')], seen)),
        cwd: workspace,
        route: 'stub/model',
        task: 'use the demo skill',
        jzhHome: home,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    // The first request carries the catalog of every root.
    expect(seen[0]).toContain('<available_skills>')
    expect(seen[0]).toContain('- demo: Explains how to greet')
    expect(seen[0]).toContain('- other: Does something else')

    // The tool result carries the instructions, and the next request reads them.
    const opened = await Effect.runPromise(
      jsonlSessions({ root }).open(
        (await Effect.runPromise(jsonlSessions({ root }).list()))[0]?.id ?? '',
      ),
    )
    const result = opened.events.find((event) => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.data.isError : true).toBe(false)
    expect(JSON.stringify(result?.data)).toContain(BODY_MARKER)
    expect(JSON.stringify(result?.data)).not.toContain('description: Explains')
    expect(seen[1]).toContain(BODY_MARKER)

    // The catalog is durable, and published once.
    expect(
      opened.events.filter(
        (event) => event.type === 'user/message' && event.data.source === 'skill-catalog',
      ),
    ).toHaveLength(1)

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('a skill added while the session runs reaches the next turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skill-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-home-'))
    const seen: Array<string> = []

    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(root)],
        plugins: plugins(
          stubLlm([textTurn('first'), textTurn('second')], seen, () => {
            const late = join(workspace, '.jzh', 'skills', 'late')
            mkdirSync(late, { recursive: true })
            writeFileSync(join(late, 'SKILL.md'), skillText('late', 'Appears later', 'late body'))
          }),
        ),
        cwd: workspace,
        route: 'stub/model',
        lines: Stream.make('first', 'second'),
        jzhHome: home,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    expect(seen[0]).not.toContain('- late: Appears later')
    expect(seen[1]).toContain('- late: Appears later')

    const opened = await Effect.runPromise(
      jsonlSessions({ root }).open(
        (await Effect.runPromise(jsonlSessions({ root }).list()))[0]?.id ?? '',
      ),
    )
    const catalogs = opened.events.flatMap((event, index) =>
      event.type === 'user/message' && event.data.source === 'skill-catalog' ? [index] : [],
    )
    const tasks = opened.events.flatMap((event, index) =>
      event.type === 'user/message' && event.data.source === 'user' ? [index] : [],
    )
    // The bundled catalog opens the session; the changed one lands between the tasks.
    expect(catalogs).toHaveLength(2)
    expect(catalogs[0]).toBeLessThan(tasks[0] ?? Number.MAX_SAFE_INTEGER)
    expect(catalogs[1]).toBeGreaterThan(tasks[0] ?? -1)
    expect(catalogs[1]).toBeLessThan(tasks[1] ?? Number.MAX_SAFE_INTEGER)

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('a session without workspace skills publishes only the bundled catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skill-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-home-'))
    const seen: Array<string> = []

    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(root)],
        plugins: plugins(stubLlm([textTurn('done')], seen)),
        cwd: workspace,
        route: 'stub/model',
        task: 'say done',
        jzhHome: home,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    expect(code).toBe(0)

    // The Office skills ship with jzh, so a blank workspace still opens with them.
    expect(seen[0]).toContain('<available_skills>')
    expect(seen[0]).toContain('- docx:')
    expect(seen[0]).toContain('- pptx:')
    expect(seen[0]).toContain('- xlsx:')
    const opened = await Effect.runPromise(
      jsonlSessions({ root }).open(
        (await Effect.runPromise(jsonlSessions({ root }).list()))[0]?.id ?? '',
      ),
    )
    expect(
      opened.events.some(
        (event) =>
          event.type === 'user/message' &&
          event.data.source === 'skill-catalog' &&
          event.data.text.includes('- docx:'),
      ),
    ).toBe(true)

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })
})
