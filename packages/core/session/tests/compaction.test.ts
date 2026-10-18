import { Effect } from 'effect'
import type { ContentBlock } from '@jozo-harness/llm'
import { describe, expect, test } from 'vitest'
import {
  SessionError,
  decodeSessionEvent,
  deriveMessages,
  pruneFor,
  type CompactionPrune,
} from '../src/index.ts'
import { event, headerEvent } from './support.ts'

/** Content the test makes up, so the rule cannot be satisfied by memorising an input. */
const longText = (size: number): string => crypto.randomUUID() + 'x'.repeat(size)

// A target only the newest message fits in, so the tests name one message at a time.
const options = { retainTokens: 5, maxBytes: 100 }

/** One assistant tool call, its oversized result, and the newest user message. */
const history = (size: number) => {
  const text = longText(size)
  return {
    text,
    events: [
      headerEvent(),
      event(2, 'assistant/message', {
        provider: 'p',
        model: 'm',
        content: [{ type: 'tool-call' as const, id: 'c1', name: 'echo', arguments: '{}' }],
        stream: [],
      }),
      event(3, 'tool/result', {
        callId: 'c1',
        isError: false,
        content: [{ type: 'text' as const, text }],
      }),
      event(4, 'user/message', { text: 'go', source: 'user' as const }),
    ],
  }
}

const textOf = (message: {
  readonly content: ReadonlyArray<{ type: string; text?: string }>
}): string =>
  message.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n')

const stubOf = (content: ReadonlyArray<{ type: string; text?: string }>): string => {
  const [block] = content
  return block?.type === 'text' ? (block.text ?? '') : ''
}

describe('pruneFor', () => {
  test('a short history has nothing to prune', () => {
    const { events } = history(20)

    expect(pruneFor(events, options)).toBeUndefined()
  })

  test('names the events whose content the request stops carrying', () => {
    const { text, events } = history(500)

    const prune = pruneFor(events, options)

    expect(prune?.shadowedSeqs).toEqual([3])
    expect(prune?.shadowedRange).toEqual({ start: 3, end: 3 })
    expect(prune?.shadowedBytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(prune?.replacements.map((replacement) => replacement.seq)).toEqual([3])
  })

  test('the replacement keeps the head of the content and names its price', () => {
    const { text, events } = history(500)

    const prune = pruneFor(events, options)
    const stub = stubOf(prune?.replacements[0]?.content ?? [])

    expect(
      stub.startsWith('[earlier output of ' + Buffer.byteLength(text, 'utf8') + ' bytes]'),
    ).toBe(true)
    expect(stub).toContain(text.slice(0, 40))
  })

  test('never hides the system prompt', () => {
    const events = [
      headerEvent(),
      event(2, 'system/message', { text: longText(500) }),
      event(3, 'user/message', { text: 'go', source: 'user' as const }),
    ]

    expect(pruneFor(events, options)).toBeUndefined()
  })

  test('an older system prompt folds as history while the newest stays the frame', () => {
    const events = [
      headerEvent(),
      event(2, 'system/message', { text: longText(500) }),
      event(3, 'system/message', { text: longText(500) }),
      event(4, 'user/message', { text: 'go', source: 'user' as const }),
    ]

    const prune = pruneFor(events, options)

    // The prompt the model was given first is history now; the newest is the frame.
    expect(prune?.shadowedSeqs).toEqual([2])
  })

  test('drops reasoning from an old message and records that too', () => {
    const events = [
      headerEvent(),
      event(2, 'assistant/message', {
        provider: 'p',
        model: 'm',
        content: [
          { type: 'reasoning' as const, text: 'thinking' },
          { type: 'text' as const, text: 'the answer' },
        ],
        stream: [],
      }),
      event(3, 'user/message', { text: 'go', source: 'user' as const }),
    ]

    const prune = pruneFor(events, { retainTokens: 5, maxBytes: 10_000 })

    expect(prune?.shadowedSeqs).toEqual([2])
    expect(prune?.replacements[0]?.content.map((block) => block.type)).toEqual(['text'])
  })
})

describe('the retention boundary', () => {
  /** Four messages of the same size, so only the token target decides where the tail starts. */
  const fourMessages = () => {
    const texts = [400, 400, 400, 400].map(longText)
    return {
      texts,
      events: [
        headerEvent(),
        event(2, 'system/message', { text: 'the frame' }),
        ...texts.map((text, index) =>
          event(3 + index, 'user/message', { text, source: 'user' as const }),
        ),
      ],
    }
  }

  test('is a token target, not a message count', () => {
    const { events } = fourMessages()

    // Each message is 436 bytes, 109 tokens: 250 keeps the newest two and no more.
    const prune = pruneFor(events, { retainTokens: 250, maxBytes: 10 })

    expect(prune?.shadowedSeqs).toEqual([3, 4])
  })

  test('keeps the newest message even when it alone is over the target', () => {
    const { events } = fourMessages()

    const prune = pruneFor(events, { retainTokens: 1, maxBytes: 10 })

    // Everything older is outside; the message the model just answered stays.
    expect(prune?.shadowedSeqs).toEqual([3, 4, 5])
  })
})

describe('the tool-result pruner', () => {
  const oldToolResult = (content: ReadonlyArray<ContentBlock>) => [
    headerEvent(),
    event(2, 'tool/result', { callId: 'c1', isError: false, content }),
    event(3, 'user/message', { text: 'go', source: 'user' as const }),
  ]

  test('keeps the head and the tail of a long tool result and names the cut', () => {
    const text = 'a'.repeat(1000) + 'b'.repeat(8000) + 'c'.repeat(1000)
    const events = oldToolResult([{ type: 'text', text }])

    const prune = pruneFor(events, { retainTokens: 5, maxBytes: 1_000_000 })
    const kept = stubOf(prune?.replacements[0]?.content ?? [])

    expect(kept).toContain('[... tool result middle pruned ...]')
    expect(kept.startsWith('a'.repeat(1000))).toBe(true)
    expect(kept.endsWith('c'.repeat(1000))).toBe(true)
    expect(kept).not.toContain('b'.repeat(5000))
    expect(kept).toContain('b'.repeat(200))
  })

  test('a tool result inside the price is left alone', () => {
    const events = oldToolResult([{ type: 'text', text: 'short enough' }])

    expect(pruneFor(events, { retainTokens: 5, maxBytes: 1_000_000 })).toBeUndefined()
  })

  test('an old image becomes a reference that says how to see it again', () => {
    const events = oldToolResult([
      {
        type: 'image',
        mediaType: 'image/png',
        data: 'QUJD'.repeat(1000),
        name: '/work/pic.png',
      },
    ])

    const prune = pruneFor(events, { retainTokens: 5, maxBytes: 1_000_000 })
    const content = prune?.replacements[0]?.content ?? []

    expect(content).toEqual([
      {
        type: 'text',
        text: '[image offloaded: /work/pic.png; read it again with the read_image tool to see it]',
      },
    ])
    const recorded = [...events, event(4, 'compaction/prune', prune as CompactionPrune)]
    expect(JSON.stringify(deriveMessages(recorded))).not.toContain('QUJD')
  })
})

describe('deriveMessages with a recorded prune', () => {
  test('carries the replacement instead of the shadowed content', () => {
    const { text, events } = history(500)
    const prune = pruneFor(events, options) as CompactionPrune
    const recorded = [...events, event(5, 'compaction/prune', prune)]

    const messages = deriveMessages(recorded)
    const tool = messages.find((message) => message.role === 'tool')

    expect(tool?.toolCallId).toBe('c1')
    expect(textOf(tool ?? { content: [] })).toContain('[earlier output of')
    expect(JSON.stringify(messages)).not.toContain(text)
    expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'user'])
  })

  test('the recorded log is pruned once, not again', () => {
    const { events } = history(500)
    const prune = pruneFor(events, options) as CompactionPrune
    const recorded = [...events, event(5, 'compaction/prune', prune)]

    expect(pruneFor(recorded, options)).toBeUndefined()
  })

  test('only the pruned message changes', () => {
    const { events } = history(500)
    const prune = pruneFor(events, options) as CompactionPrune
    const recorded = [...events, event(5, 'compaction/prune', prune)]

    expect(deriveMessages(recorded)).toEqual(
      deriveMessages(events).map((message) =>
        message.role === 'tool'
          ? { ...message, content: prune.replacements[0]?.content ?? [] }
          : message,
      ),
    )
  })
})

describe('the prune event in the log', () => {
  test('decodes from JSONL', async () => {
    const { events } = history(500)
    const prune = pruneFor(events, options) as CompactionPrune

    const decoded = await Effect.runPromise(
      decodeSessionEvent({ seq: 5, time: 1, type: 'compaction/prune', data: prune }),
    )

    expect(decoded?.type).toBe('compaction/prune')
  })

  test('a malformed prune is refused', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decodeSessionEvent({
          seq: 5,
          time: 1,
          type: 'compaction/prune',
          data: { shadowedSeqs: 'no' },
        }),
      ),
    )

    expect(error).toBeInstanceOf(SessionError)
  })
})
