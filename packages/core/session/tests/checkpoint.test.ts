import { Effect } from 'effect'
import type { RequestMessage } from '@jozo-harness/llm'
import { describe, expect, test } from 'vitest'
import {
  CHECKPOINT_PREAMBLE,
  SessionError,
  checkpointOf,
  decodeSessionEvent,
  deriveMessages,
  messagesWithPrune,
  pruneFor,
  summarizableMessages,
} from '../src/index.ts'
import { event, headerEvent } from './support.ts'

// The newest message is 19 bytes, 5 tokens: a target this size keeps it alone.
const options = { retainTokens: 5, maxBytes: 100 }

/** One old exchange, its oversized tool result, and the newest user message. */
const history = () => {
  const text = crypto.randomUUID() + 'x'.repeat(400)
  return {
    text,
    events: [
      headerEvent(),
      event(2, 'system/message', { text: 'the frame' }),
      event(3, 'user/message', { text: 'the first request', source: 'user' as const }),
      event(4, 'assistant/message', {
        provider: 'p',
        model: 'm',
        content: [{ type: 'tool-call' as const, id: 'c1', name: 'echo', arguments: '{}' }],
        stream: [],
      }),
      event(5, 'tool/result', {
        callId: 'c1',
        isError: false,
        content: [{ type: 'text' as const, text }],
      }),
      event(6, 'user/message', { text: 'the newest request', source: 'user' as const }),
    ],
  }
}

const checkpoint = (seq: number, shadowedSeqs: ReadonlyArray<number>, summary: string) =>
  event(seq, 'compaction/checkpoint', {
    shadowedSeqs,
    shadowedRange: { start: shadowedSeqs[0] ?? 0, end: shadowedSeqs[shadowedSeqs.length - 1] ?? 0 },
    summary,
    provider: 'p',
    model: 'm',
  })

const textOf = (message: {
  readonly content: ReadonlyArray<{ type: string; text?: string }>
}): string =>
  message.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n')

describe('summarizableMessages', () => {
  test('is the history outside the retention, without the system frame', () => {
    const { events } = history()

    const range = summarizableMessages(events, options)

    // The newest user message is retained; the frame never enters a summary.
    expect(range.map((entry) => entry.seq)).toEqual([3, 4, 5])
  })

  test('summarizes an older system prompt while the newest stays the frame', () => {
    const events = [
      headerEvent(),
      event(2, 'system/message', { text: 'the old frame' }),
      event(3, 'system/message', { text: 'the new frame' }),
      event(4, 'user/message', { text: 'the newest request', source: 'user' as const }),
    ]

    const range = summarizableMessages(events, options)

    expect(range.map((entry) => entry.seq)).toEqual([2])
  })

  test('leaves nothing when the whole history is retained', () => {
    const { events } = history()

    expect(summarizableMessages(events, { ...options, retainTokens: 1_000 })).toEqual([])
  })

  test('counts tokens, so a big retained message ends the range earlier', () => {
    const { events } = history()

    // The newest message (5 tokens) plus the tool result before it (109) is 114: a
    // 114-token target keeps both and stops before the tool call that produced it.
    const range = summarizableMessages(events, { ...options, retainTokens: 114 })

    expect(range.map((entry) => entry.seq)).toEqual([3, 4])
  })
})

describe('messagesWithPrune', () => {
  test('hands the summarizer what the request would have carried', () => {
    const { events, text } = history()
    const prune = pruneFor(events, options)

    const messages = messagesWithPrune(summarizableMessages(events, options), prune)

    expect(JSON.stringify(messages)).not.toContain(text)
    expect(JSON.stringify(messages)).toContain('[earlier output of')
  })
})

describe('checkpointOf', () => {
  test('names the range in seq order, whatever order the fold is in', () => {
    const message = (text: string): RequestMessage => ({
      role: 'user',
      content: [{ type: 'text', text }],
    })
    // A second compaction takes the previous summary, which the fold puts at the head of
    // its span with the seq the checkpoint was recorded at, and newer messages after it.
    const range = [
      { seq: 9, message: message('the previous summary') },
      { seq: 4, message: message('an older message') },
      { seq: 5, message: message('a newer one') },
    ]

    const checkpoint = checkpointOf(range, 'condensed', { provider: 'p', model: 'm' })

    expect(checkpoint?.shadowedRange).toEqual({ start: 4, end: 9 })
  })
})

describe('the checkpoint in the fold', () => {
  test('replaces the summarized range with one message and keeps the tail', () => {
    const { events } = history()
    const recorded = [...events, checkpoint(7, [3, 4, 5], 'what happened before')]

    const messages = deriveMessages(recorded)

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(textOf(messages[1] ?? { content: [] })).toBe(
      CHECKPOINT_PREAMBLE + 'what happened before',
    )
    expect(textOf(messages[2] ?? { content: [] })).toBe('the newest request')
  })

  test('a range an earlier checkpoint already replaced leaves the fold alone', () => {
    const { events } = history()
    const once = [...events, checkpoint(7, [3, 4, 5], 'first summary')]
    const twice = [...once, checkpoint(8, [3, 4, 5], 'second summary')]

    const messages = deriveMessages(twice)

    expect(JSON.stringify(messages)).toContain('first summary')
    expect(JSON.stringify(messages)).not.toContain('second summary')
  })
})

describe('the checkpoint event in the log', () => {
  test('decodes from JSONL', async () => {
    const recorded = checkpoint(7, [3, 4, 5], 'what happened before')

    const decoded = await Effect.runPromise(
      decodeSessionEvent({
        seq: 7,
        time: 1,
        type: 'compaction/checkpoint',
        data: (recorded as { readonly data: unknown }).data,
      }),
    )

    expect(decoded?.type).toBe('compaction/checkpoint')
  })

  test('a malformed checkpoint is refused', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decodeSessionEvent({
          seq: 7,
          time: 1,
          type: 'compaction/checkpoint',
          data: { shadowedSeqs: 'no' },
        }),
      ),
    )

    expect(error).toBeInstanceOf(SessionError)
  })
})
