import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type LlmUsage, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { deriveMessages, sessionPlugin, type SessionEvent } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const BIG = 'x'.repeat(40_000)

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

/** What the model was sent, in the shape the log can be read back into. */
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

/** Captures every request the model made, with the usage it reported when given. */
const spy = (
  seen: Array<ReadonlyArray<SentMessage>>,
  usage?: LlmUsage,
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
        const last = messages[messages.length - 1]?.text ?? ''
        // The compaction engine's own call is answered, but it is not an agent request.
        if (last.includes('compaction engine')) {
          return Stream.fromIterable(textTurn('the earlier span, condensed'))
        }
        seen.push(messages)
        return Stream.fromIterable([
          ...(usage === undefined ? [] : [{ type: 'usage' as const, usage }]),
          ...textTurn('ok'),
        ])
      },
    } satisfies LlmAdapter),
})

/** The same stub, answering every agent request with text of the given size. */
const longSpy = (
  seen: Array<ReadonlyArray<SentMessage>>,
  answer: string,
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
        const last = messages[messages.length - 1]?.text ?? ''
        if (last.includes('compaction engine')) {
          return Stream.fromIterable(textTurn('the earlier span, condensed'))
        }
        seen.push(messages)
        return Stream.fromIterable(textTurn(answer))
      },
    } satisfies LlmAdapter),
})

const profile = (root: string, loopConfig?: string): string =>
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
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
    ...(loopConfig === undefined
      ? []
      : ['    config:', ...loopConfig.split('\n').map((l) => '      ' + l)]),
  ].join('\n')

const plugins = (llm: Plugin<{}, Llm, never>): ReadonlyArray<Plugin<any, any, any>> => [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  safetyPlugin,
  askPlugin,
  llm,
  agentPlugin,
  agentLoopPlugin,
]

/** Whether the log records any compaction: a summary, a prune, or both. */
const compacted = (events: ReadonlyArray<{ readonly type: string }>): boolean =>
  events.some((event) => event.type.startsWith('compaction/'))

const open = async (root: string) => {
  const listed = await Effect.runPromise(jsonlSessions({ root }).list())
  return {
    id: listed[0]?.id ?? '',
    opened: await Effect.runPromise(jsonlSessions({ root }).open(listed[0]?.id ?? '')),
  }
}

/**
 * The size of the request each checkpoint was recorded for, in the tokens the meter's
 * own rule counts. Nothing is appended between the checkpoint and the request it was
 * written for, so the fold at the checkpoint is that request; a summary that leaves it
 * over the line makes the next step compact again.
 */
const tokensAfterCheckpoints = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<number> =>
  events
    .filter((event) => event.type === 'compaction/checkpoint')
    .map((checkpoint) => {
      const bytes = asSeen(deriveMessages(events.slice(0, events.indexOf(checkpoint) + 1))).reduce(
        (sum, message) => sum + Buffer.byteLength(message.text, 'utf8'),
        0,
      )
      return Math.ceil(bytes / 4)
    })

/** Runs one task per turn in the same session and reports the last request and log. */
const runTasks = async (
  root: string,
  tasks: ReadonlyArray<string>,
  loopConfig?: string,
  llmOf: (seen: Array<ReadonlyArray<SentMessage>>) => Plugin<{}, Llm, never> = (seen) => spy(seen),
): Promise<{
  readonly sent: ReadonlyArray<SentMessage>
  readonly opened: Awaited<ReturnType<typeof open>>['opened']
}> => {
  let resume: string | undefined = undefined
  let sent: ReadonlyArray<SentMessage> = []
  for (const task of tasks) {
    const seen: Array<ReadonlyArray<SentMessage>> = []
    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(root, loopConfig)],
        plugins: plugins(llmOf(seen)),
        cwd: '/tmp',
        route: 'stub/model',
        task,
        stdout: () => undefined,
        stderr: () => undefined,
        ...(resume === undefined ? {} : { resume }),
      }),
    )
    expect(code).toBe(0)
    sent = seen[0] ?? []
    resume = (await open(root)).id
  }
  return { sent, opened: (await open(root)).opened }
}

describe('compaction through the command', () => {
  test('the log alone reconstructs the request the model was sent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const { sent, opened } = await runTasks(
      root,
      [BIG, 'two', 'three', 'four', 'five', 'six', 'seven'],
      // A window small enough that this conversation is over the threshold.
      'contextWindow: 8000\nheadroomTokens: 0',
    )

    const texts = sent.map((message) => message.text)
    expect(texts.some((text) => text.includes('the earlier span, condensed'))).toBe(true)
    expect(texts.some((text) => text === BIG)).toBe(false)

    // The request is derived from the log: the logged events, folded with the
    // recorded compaction, are exactly what the model was sent (plus its answer).
    const derived = asSeen(deriveMessages(opened.events))
    expect(compacted(opened.events)).toBe(true)
    expect(sent.length).toBeGreaterThan(0)
    expect(derived.slice(0, sent.length)).toEqual([...sent])

    await rm(root, { recursive: true, force: true })
  })

  test('the profile row decides when a message is compacted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const small = 'y'.repeat(100)

    const { sent, opened } = await runTasks(
      root,
      [small, 'second'],
      'retainTokens: 1\nmaxBytes: 10\ncontextWindow: 100\nheadroomTokens: 0',
    )

    const checkpoint = opened.events.find((event) => event.type === 'compaction/checkpoint')
    expect(checkpoint?.type === 'compaction/checkpoint' ? checkpoint.data.summary : '').toContain(
      'condensed',
    )
    expect(sent.some((message) => message.text === small)).toBe(false)

    await rm(root, { recursive: true, force: true })
  })

  test('the routed model row decides when a message is compacted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const small = 'w'.repeat(100)

    // The route is stub/model; no single contextWindow is set, so only the row
    // named for that model can put this conversation over the line.
    const { opened } = await runTasks(
      root,
      [small, 'second'],
      'models:\n  model:\n    contextWindow: 100\n    maxTokens: 50\nheadroomTokens: 0',
    )

    expect(compacted(opened.events)).toBe(true)

    await rm(root, { recursive: true, force: true })
  })

  test('a request right after a summary is under the line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    // 16,000 tokens of window and no headroom: the line sits at 12,800.
    const line = 12_800
    const big = 'z'.repeat(4_800)

    // Eleven exchanges of 1,200 tokens each: a retention counted in messages keeps the
    // last twelve, which is twice the line, so the request never comes back under it.
    const { opened } = await runTasks(
      root,
      Array.from({ length: 11 }, () => big),
      'contextWindow: 16000\nheadroomTokens: 0',
      (seen) => longSpy(seen, big),
    )

    const checkpoints = opened.events.filter((event) => event.type === 'compaction/checkpoint')
    expect(checkpoints.length).toBeGreaterThan(0)
    expect(tokensAfterCheckpoints(opened.events).every((tokens) => tokens < line)).toBe(true)

    await rm(root, { recursive: true, force: true })
  })

  test('the window a profile does not name keeps its own line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    // No budget in the row: 128,000 tokens of window and 65,536 of headroom.
    const line = 62_464
    const big = 'z'.repeat(4_800)

    const { opened } = await runTasks(
      root,
      Array.from({ length: 30 }, () => big),
      undefined,
      (seen) => longSpy(seen, big),
    )

    const checkpoints = opened.events.filter((event) => event.type === 'compaction/checkpoint')
    expect(checkpoints.length).toBeGreaterThan(0)
    expect(tokensAfterCheckpoints(opened.events).every((tokens) => tokens < line)).toBe(true)

    await rm(root, { recursive: true, force: true })
  })

  test('a conversation with room left is sent untouched', async () => {
    const roomy = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const tight = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const first = 'the first thing the model was told'
    const tasks = [first, 'second']

    const under = await runTasks(
      roomy,
      tasks,
      'retainTokens: 1\nmaxBytes: 10\ncontextWindow: 100000\nheadroomTokens: 0',
    )
    const over = await runTasks(
      tight,
      tasks,
      'retainTokens: 1\nmaxBytes: 10\ncontextWindow: 100\nheadroomTokens: 0',
    )

    // The same history, the same prune price: only the budget decides.
    expect(compacted(under.opened.events)).toBe(false)
    expect(under.sent.some((message) => message.text === first)).toBe(true)
    expect(compacted(over.opened.events)).toBe(true)
    expect(over.sent.some((message) => message.text === first)).toBe(false)

    await rm(roomy, { recursive: true, force: true })
    await rm(tight, { recursive: true, force: true })
  })

  test('a request that reserves output compacts against the shorter line', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const reserved = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    // The frame is recorded once, so the message itself carries the pressure on the
    // second request: over the reserved line, under the unreserved one.
    const tasks = ['the first thing the model was told '.repeat(20), 'second']
    // The window is 1,000 tokens: without a reservation the line is 800, and with 900
    // reserved for the answer it is 100.
    const budget = 'contextWindow: 1000\nthresholdRatio: 0.8\nheadroomTokens: 0'

    const without = await runTasks(plain, tasks, budget)
    const with900 = await runTasks(reserved, tasks, `${budget}\nmaxTokens: 900`)

    expect(compacted(without.opened.events)).toBe(false)
    expect(compacted(with900.opened.events)).toBe(true)

    // The log records what the request reserved, so the line can be read back from it.
    const header = with900.opened.events.find((event) => event.type === 'request/header')
    expect(header?.type === 'request/header' ? header.data.params['max_tokens'] : undefined).toBe(
      900,
    )

    await rm(plain, { recursive: true, force: true })
    await rm(reserved, { recursive: true, force: true })
  })

  test('what the provider counted is what pushes the request over', async () => {
    const roomy = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const tight = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const first = 'the first thing the model was told'
    const tasks = [first, 'second']
    const budget =
      'retainTokens: 1\nmaxBytes: 10\ncontextWindow: 1000\nthresholdRatio: 0.9\nheadroomTokens: 0'

    // The bytes are tiny in both runs; only the reported usage differs.
    const under = await runTasks(roomy, tasks, budget, (seen) =>
      spy(seen, { inputTokens: 5, outputTokens: 5 }),
    )
    const over = await runTasks(tight, tasks, budget, (seen) =>
      spy(seen, { inputTokens: 900, outputTokens: 50 }),
    )

    expect(compacted(under.opened.events)).toBe(false)
    expect(compacted(over.opened.events)).toBe(true)

    await rm(roomy, { recursive: true, force: true })
    await rm(tight, { recursive: true, force: true })
  })

  test('a summarizer that cannot answer leaves the prune as the fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const first = 'the first thing the model was told'

    const noSummary = (seen: Array<ReadonlyArray<SentMessage>>): Plugin<{}, Llm, never> => ({
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
            const last = messages[messages.length - 1]?.text ?? ''
            if (last.includes('compaction engine')) {
              return Stream.fromIterable(textTurn(''))
            }
            seen.push(messages)
            return Stream.fromIterable(textTurn('ok'))
          },
        } satisfies LlmAdapter),
    })

    const { sent, opened } = await runTasks(
      root,
      [first, 'second'],
      'retainTokens: 1\nmaxBytes: 10\ncontextWindow: 100\nheadroomTokens: 0',
      noSummary,
    )

    // No summary was written, so the recorded prune is what the request carries.
    expect(opened.events.some((event) => event.type === 'compaction/checkpoint')).toBe(false)
    const prune = opened.events.find((event) => event.type === 'compaction/prune')
    expect(prune?.type === 'compaction/prune' ? prune.data.shadowedBytes : 0).toBeGreaterThan(0)
    expect(sent.some((message) => message.text === first)).toBe(false)
    expect(sent.some((message) => message.text.startsWith('[earlier output of'))).toBe(true)

    await rm(root, { recursive: true, force: true })
  })

  test('an old span becomes one summary the next request carries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-compact-'))
    const first = 'the first thing the model was told'
    const summary = 'SUMMARY-OF-THE-OLD-SPAN-7413'
    const summarized: Array<string> = []

    const summaryLlm = (seen: Array<ReadonlyArray<SentMessage>>): Plugin<{}, Llm, never> => ({
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
            const last = messages[messages.length - 1]?.text ?? ''
            // The compaction engine's call is answered with the checkpoint text.
            if (last.includes('compaction engine')) {
              summarized.push(messages.map((message) => message.text).join('\n'))
              return Stream.fromIterable(textTurn(summary))
            }
            seen.push(messages)
            return Stream.fromIterable(textTurn('ok'))
          },
        } satisfies LlmAdapter),
    })

    // The second request carries enough input of its own to cross the line: the
    // system frame is recorded once and no longer pads every turn. Measured, the
    // first request is 169 tokens and the second 206, so a 240-token window puts
    // the line at 192 between them: the first turn is sent as it is, the second
    // folds the old span once.
    const { sent, opened } = await runTasks(
      root,
      [first, 'the second thing the model was told '.repeat(4)],
      'retainTokens: 1\nmaxBytes: 10\ncontextWindow: 240\nheadroomTokens: 0',
      summaryLlm,
    )

    // The auxiliary call read the span it was asked to condense.
    expect(summarized).toHaveLength(1)
    expect(summarized[0]).toContain(first)

    // The log records the summary and the span it stands for, so it is traceable.
    const checkpoint = opened.events.find((event) => event.type === 'compaction/checkpoint')
    const data = checkpoint?.type === 'compaction/checkpoint' ? checkpoint.data : undefined
    expect(data?.summary).toBe(summary)
    expect(data?.shadowedSeqs.length).toBeGreaterThan(0)
    expect(data?.shadowedRange.start).toBeLessThanOrEqual(data?.shadowedRange.end ?? 0)

    // The next request carries the summary, not the span it replaced.
    expect(sent.some((message) => message.text.includes(summary))).toBe(true)
    expect(sent.some((message) => message.text === first)).toBe(false)
    const derived = asSeen(deriveMessages(opened.events))
    expect(derived.some((message) => message.text.includes(summary))).toBe(true)
    expect(derived.some((message) => message.text === first)).toBe(false)

    await rm(root, { recursive: true, force: true })
  })
})
