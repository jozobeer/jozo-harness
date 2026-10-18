import { describe, expect, test } from 'vitest'
import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCommand } from '../src/index.ts'

const reply: ReadonlyArray<StreamChunk> = [
  { type: 'text-delta', index: 0, text: 'ok' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
  { type: 'finish', kind: 'stop' },
]

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
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

/** Runs the REPL over the given lines and reports what it printed. */
const runLines = async (lines: ReadonlyArray<string>) => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-cmd-'))
  const out: Array<string> = []
  const stub: Plugin<{}, Llm, never> = {
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
        stream: () => Stream.fromIterable(reply),
      } satisfies LlmAdapter),
  }

  const code = await Effect.runPromise(
    runCommand({
      profiles: [profile(root)],
      plugins: [
        kernelPlugin,
        sessionJsonlPlugin,
        sessionPlugin,
        toolsPlugin,
        systemPromptPlugin,
        stub,
        agentPlugin,
        agentLoopPlugin,
      ] as ReadonlyArray<Plugin<any, any, any>>,
      cwd: '/work',
      route: 'stub/model',
      lines: Stream.fromIterable(lines),
      stdout: (text) => {
        out.push(text)
      },
      stderr: () => undefined,
    }),
  )

  const listed = await Effect.runPromise(jsonlSessions({ root }).list())
  const opened = await Effect.runPromise(jsonlSessions({ root }).open(listed[0]?.id ?? ''))
  await rm(root, { recursive: true, force: true })
  return { code, printed: out.join(''), events: opened.events }
}

describe('commands in the REPL', () => {
  test('a command answers where it stands and never becomes a turn', async () => {
    // After one message, so the status has a model and a turn to report.
    const observed = await runLines(['hello', '/status'])
    const users = observed.events.flatMap((event) =>
      event.type === 'user/message' && event.data.source === 'user' ? [event.data.text] : [],
    )
    const commands = observed.events.flatMap((event) =>
      event.type === 'command/run' || event.type === 'command/done' ? [event.type] : [],
    )

    expect(observed.code).toBe(0)
    expect(observed.printed).toContain('model: stub/model')
    expect(observed.printed).toContain('turns: 1')
    // The stub reports no usage: the stats say so with dashes rather than zeroes.
    expect(observed.printed).toContain('stats: tok/s — · — · cache —')
    expect(observed.printed).toContain('goal: none')
    expect(observed.printed).toContain('schedules: none')
    // The command was answered, and the model was never woken with it.
    expect(commands).toEqual(['command/run', 'command/done'])
    expect(users).toEqual(['hello'])
    expect(observed.events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
  })

  test('the model and effort commands switch the request that follows them', async () => {
    const observed = await runLines(['/model stub/other', '/effort max', 'hello'])
    const headers = observed.events.flatMap((event) =>
      event.type === 'request/header' ? [event.data] : [],
    )

    expect(observed.code).toBe(0)
    expect(observed.printed).toContain('model: stub/other')
    expect(observed.printed).toContain('effort: max')
    expect(headers.at(-1)?.provider).toBe('stub')
    expect(headers.at(-1)?.model).toBe('other')
    expect(headers.at(-1)?.params.reasoning_effort).toBe('max')
  })

  test('a goal command records the goal the tool would and moves its phase', async () => {
    const observed = await runLines([
      '/goal ship it',
      '/goal pause',
      '/status',
      '/goal resume',
      '/goal edit better',
      '/goal done',
      '/status',
      '/goal',
    ])
    const goals = observed.events.flatMap((event) =>
      event.type === 'goal/updated' ? [event.data] : [],
    )

    expect(observed.code).toBe(0)
    // The command writes exactly the state the goal tool writes: one shape, one fold.
    expect(goals).toEqual([
      { objective: 'ship it', phase: 'active', maxGoalRounds: 256 },
      { objective: 'ship it', phase: 'paused', maxGoalRounds: 256 },
      { objective: 'ship it', phase: 'active', maxGoalRounds: 256 },
      { objective: 'better', phase: 'active', maxGoalRounds: 256 },
      { objective: 'better', phase: 'complete', maxGoalRounds: 256 },
    ])
    expect(observed.printed).toContain('goal active 0/256: ship it')
    expect(observed.printed).toContain('goal: paused 0/256 — ship it')
    expect(observed.printed).toContain('goal: complete 0/256 — better')
    // A command is not a turn: the model was never woken.
    expect(observed.events.filter((event) => event.type === 'turn/start')).toHaveLength(0)
  })

  test('help lists what can be typed, and an unknown command says so', async () => {
    const observed = await runLines(['/help', '/nope', 'and a message'])

    expect(observed.printed).toContain('/help')
    expect(observed.printed).toContain('/status')
    expect(observed.printed).toContain('unknown command: nope')
    // The message after them still reached the model as a turn.
    expect(observed.events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
    expect(
      observed.events.flatMap((event) =>
        event.type === 'user/message' && event.data.source === 'user' ? [event.data.text] : [],
      ),
    ).toEqual(['and a message'])
  })
})
