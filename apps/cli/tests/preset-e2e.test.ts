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
import { runCommand, type CommandOptions } from '../src/index.ts'

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

/** The rows a profile names, with or without the Tier 1 tools. */
const profile = (root: string, name: string, withTier1: boolean): string =>
  [
    'name: ' + name,
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
    ...(withTier1 ? ['  - id: tier1', "    name: '@jozo-harness/tools-tier1'"] : []),
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const plugins = (withTier1: boolean): ReadonlyArray<Plugin<any, any, any>> => [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  safetyPlugin,
  askPlugin,
  tier0Plugin,
  ...(withTier1 ? [tier1Plugin] : []),
  stubLlm(),
  agentPlugin,
  agentLoopPlugin,
]

const run = (
  options: Partial<CommandOptions> & { readonly profile: string; readonly tier1: boolean },
): Promise<{ readonly code: number; readonly stderr: string }> => {
  const errs: Array<string> = []
  return Effect.runPromise(
    runCommand({
      profiles: [options.profile],
      plugins: plugins(options.tier1),
      cwd: '/tmp',
      route: 'stub/model',
      stdout: () => undefined,
      stderr: (text) => {
        errs.push(text)
      },
      ...options,
    }),
  ).then((code) => ({ code, stderr: errs.join('') }))
}

const sessionOf = async (root: string, resume: string) => {
  const opened = await Effect.runPromise(jsonlSessions({ root }).open(resume))
  return opened.events
}

describe('the composition a session was started with', () => {
  test('is recorded, and a resume under a different one is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-preset-'))
    const full = profile(root, 'full', true)
    const small = profile(root, 'small', false)

    const first = await run({ profile: full, tier1: true, task: 'first' })
    expect(first.code).toBe(0)
    const listed = await Effect.runPromise(jsonlSessions({ root }).list())
    const id = listed[0]?.id ?? ''
    const after = await sessionOf(root, id)
    const recorded = after.flatMap((event) =>
      event.type === 'preset/selected' ? [event.data] : [],
    )

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ profiles: ['full'] })
    expect(recorded[0]?.tools).toContain('write')
    expect(recorded[0]?.tools).toContain('todo_write')

    // The smaller composition is missing the tier 1 tools: refuse before any turn.
    const refused = await run({ profile: small, tier1: false, resume: id, task: 'second' })
    const stillOne = await sessionOf(root, id)

    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('profiles: full -> small')
    expect(refused.stderr).toContain('tools gone:')
    expect(refused.stderr).toContain('--allow-preset-change')
    expect(stillOne.filter((event) => event.type === 'turn/start')).toHaveLength(1)

    // The same composition continues the session.
    const same = await run({ profile: full, tier1: true, resume: id, task: 'third' })
    expect(same.code).toBe(0)

    // And a deliberate change is recorded as the session's new composition.
    const changed = await run({
      profile: small,
      tier1: false,
      resume: id,
      task: 'fourth',
      allowPresetChange: true,
    })
    const after4 = await sessionOf(root, id)

    expect(changed.code).toBe(0)
    expect(after4.filter((event) => event.type === 'turn/start')).toHaveLength(3)
    expect(
      after4.flatMap((event) => (event.type === 'preset/selected' ? [event.data.profiles] : [])),
    ).toEqual([['full'], ['small']])

    await rm(root, { recursive: true, force: true })
  })

  test('a tool this build added continues the session and is recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-preset-added-'))
    // One profile name, two compositions: only the tool set differs, as when a
    // build adds a tool to the same profile.
    const small = profile(root, 'same', false)
    const full = profile(root, 'same', true)

    const first = await run({ profile: small, tier1: false, task: 'first' })
    expect(first.code).toBe(0)
    const id = (await Effect.runPromise(jsonlSessions({ root }).list()))[0]?.id ?? ''

    // The larger composition only adds tools: no refusal, and the addition joins
    // the composition the session records.
    const grown = await run({ profile: full, tier1: true, resume: id, task: 'second' })
    const after = await sessionOf(root, id)

    expect(grown.code).toBe(0)
    expect(grown.stderr).toBe('')
    expect(after.filter((event) => event.type === 'turn/start')).toHaveLength(2)
    const records = after.flatMap((event) => (event.type === 'preset/selected' ? [event.data] : []))
    expect(records).toHaveLength(2)
    expect(records[0]?.profiles).toEqual(['same'])
    expect(records[0]?.tools).not.toContain('todo_write')
    expect(records[1]?.profiles).toEqual(['same'])
    expect(records[1]?.tools).toContain('todo_write')
    expect(records[1]?.tools.length).toBeGreaterThan(records[0]?.tools.length ?? 0)

    await rm(root, { recursive: true, force: true })
  })
})
