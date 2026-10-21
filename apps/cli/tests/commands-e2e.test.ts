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

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const reply: ReadonlyArray<StreamChunk> = textTurn('ok')

/** One message as the model was sent it: its role and its text blocks joined. */
interface SentMessage {
  readonly role: string
  readonly text: string
}

const asSeen = (
  messages: ReadonlyArray<{
    role: string
    content: ReadonlyArray<{ type: string; text?: string }>
  }>,
): ReadonlyArray<SentMessage> =>
  messages.map((message) => ({
    role: message.role,
    text: message.content
      .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
      .join('\n'),
  }))

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

/** The model that answers every request with the same words. */
const replying = (text: string): Plugin<{}, Llm, never> => ({
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
      stream: () => Stream.fromIterable(textTurn(text)),
    } satisfies LlmAdapter),
})

/**
 * A model that answers the compaction engine's own call with the summary and every
 * conversation request with 'ok', recording the latter so the request can be read.
 */
const summarizing = (
  summary: string,
  seen: Array<ReadonlyArray<SentMessage>>,
): Plugin<{}, Llm, never> => ({
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
        const messages = asSeen(request.messages)
        // The auxiliary call carries the instruction the summary is asked for with.
        if ((messages.at(-1)?.text ?? '').includes('compaction engine')) {
          return Stream.fromIterable(textTurn(summary))
        }
        seen.push(messages)
        return Stream.fromIterable(reply)
      },
    } satisfies LlmAdapter),
})

/** Runs the REPL over the given lines and reports what it printed and was sent. */
const runLines = async (
  lines: ReadonlyArray<string>,
  llmOf: (seen: Array<ReadonlyArray<SentMessage>>) => Plugin<{}, Llm, never> = () => replying('ok'),
) => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-cmd-'))
  const out: Array<string> = []
  const seen: Array<ReadonlyArray<SentMessage>> = []
  const stub = llmOf(seen)

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
  return { code, printed: out.join(''), events: opened.events, seen }
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

  test('/compact records the checkpoint from the same summary call the loop makes', async () => {
    const observed = await runLines(['x'.repeat(40_000), '/compact'])
    const checkpoints = observed.events.flatMap((event) =>
      event.type === 'compaction/checkpoint' ? [event.data] : [],
    )

    expect(observed.code).toBe(0)
    expect(observed.printed).toContain('compacted')
    // The session wired the fold to the route it asks, so the log names that model.
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({ provider: 'stub', model: 'model', summary: 'ok' })
  })

  test('the request right after /compact is the summary and the words that followed', async () => {
    const big = 'x'.repeat(40_000)
    const summary = 'SUMMARY-OF-THE-FOLDED-SPAN-255'
    const observed = await runLines([big, '/compact', 'what next?'], (seen) =>
      summarizing(summary, seen),
    )

    const before = observed.seen[0] ?? []
    const after = observed.seen[1] ?? []
    const joined = after.map((message) => message.text).join('\n')
    const bytes = (messages: ReadonlyArray<SentMessage>): number =>
      messages.reduce((sum, message) => sum + Buffer.byteLength(message.text, 'utf8'), 0)
    const checkpoint = observed.events.find((event) => event.type === 'compaction/checkpoint')

    expect(observed.code).toBe(0)
    expect(observed.printed).toContain('compacted')
    // The checkpoint the fold recorded is the summary this model gave.
    expect(checkpoint?.type === 'compaction/checkpoint' ? checkpoint.data.summary : undefined).toBe(
      summary,
    )
    // The turn after the command is the request the recorded checkpoint folds: one
    // summary in place of the span, then the words that came after it.
    expect(observed.seen).toHaveLength(2)
    expect(joined).toContain(summary)
    expect(joined).toContain('what next?')
    expect(after.some((message) => message.text === big)).toBe(false)
    // A request the fold stood in for is smaller than the one it replaced.
    expect(bytes(after)).toBeLessThan(bytes(before))
    expect(observed.events.filter((event) => event.type === 'compaction/prune')).toHaveLength(1)
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
