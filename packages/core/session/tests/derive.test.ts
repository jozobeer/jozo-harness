import { describe, expect, test } from 'vitest'
import { LlmFailure, encodeLlmFailure } from '@jozo-harness/llm'
import { deriveMessages, type MessageProjection } from '../src/index.ts'
import { event, headerEvent } from './support.ts'

describe('deriveMessages', () => {
  test('folds the model-visible events and skips attempts and metadata', () => {
    const events = [
      headerEvent(),
      event(2, 'system/message', { text: 'be brief' }),
      event(3, 'turn/start', { turn: 1 }),
      event(4, 'user/message', { text: 'hello', source: 'user' }),
      event(5, 'assistant/message', {
        provider: 'ollama-cloud',
        model: 'qwen3-coder:480b',
        content: [{ type: 'text', text: 'hi' }],
        stream: [],
      }),
      event(6, 'tool/call', { callId: 'call-1', name: 'read', arguments: '{"path":"a"}' }),
      event(7, 'assistant/message', {
        provider: 'ollama-cloud',
        model: 'qwen3-coder:480b',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }],
        stream: [],
      }),
      event(8, 'tool/result', {
        callId: 'call-1',
        isError: false,
        content: [{ type: 'text', text: 'file body' }],
      }),
      event(9, 'assistant/attempt', {
        provider: 'ollama-cloud',
        model: 'qwen3-coder:480b',
        failure: encodeLlmFailure(new LlmFailure({ code: 'TIMEOUT', message: 'no response' })),
        stream: [],
      }),
      event(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]

    expect(deriveMessages(events)).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }] },
    ])
  })

  test('a logged failure keeps its code out of the model history', () => {
    const events = [
      headerEvent(),
      event(2, 'tool/result', {
        callId: 'call-1',
        isError: true,
        content: [{ type: 'text', text: 'timed out after 10ms' }],
        error: { name: 'TimeoutError', code: 'timeout' },
      }),
    ]

    expect(deriveMessages(events)).toEqual([
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'timed out after 10ms' }],
      },
    ])
  })

  test('an extra projection owns its event type and rewrites the history so far', () => {
    const events = [
      headerEvent(),
      event(2, 'user/message', { text: 'first', source: 'user' }),
      event(3, 'user/message', { text: 'second', source: 'inject' }),
    ]
    const seen: Array<number> = []
    // A projection owns its event: it adds the message the event deserves.
    const skipInjected: MessageProjection = {
      type: 'user/message',
      name: 'skip-injected',
      project: (raw, derived) => {
        seen.push(derived.length)
        if (raw.type !== 'user/message' || raw.data.source === 'inject') return derived
        return [
          ...derived,
          {
            seq: raw.seq,
            message: {
              role: 'assistant' as const,
              content: [{ type: 'text', text: raw.data.text }],
            },
          },
        ]
      },
    }

    const derived = deriveMessages(events, [skipInjected])

    expect(seen).toEqual([0, 1])
    expect(derived).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'first' }] }])
  })
})
