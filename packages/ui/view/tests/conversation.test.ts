import { describe, expect, test } from 'vitest'
import type { UiEvent } from '@jozo-harness/ui-protocol'
import { applyEvent, emptyConversation, type Conversation } from '../src/index.ts'

let seq = 0
const session = (type: string, data: unknown): UiEvent => {
  seq += 1
  return { kind: 'session', event: { seq, time: 1_700_000_000_000 + seq, type, data } }
}
const stream = (text: string): UiEvent => ({
  kind: 'stream',
  chunk: { time: seq, chunk: { type: 'text-delta', index: 0, text } },
})
const fold = (
  events: ReadonlyArray<UiEvent>,
  from: Conversation = emptyConversation,
): Conversation => events.reduce(applyEvent, from)

describe('conversation', () => {
  test('a user turn and its answer become blocks in order', () => {
    const state = fold([
      session('turn/start', { turn: 1 }),
      session('user/message', { text: 'hello', source: 'user' }),
      session('assistant/message', {
        provider: 'stub',
        model: 'm',
        content: [{ type: 'text', text: 'hi there' }],
        stream: [],
      }),
      session('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(state.blocks).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'hi there' },
    ])
    expect(state.running).toBe(false)
  })

  test('an event whose seq was already applied is dropped', () => {
    const once = session('user/message', { text: 'hello', source: 'user' })
    const state = fold([once, once])
    expect(state.blocks).toHaveLength(1)
  })

  test('stream deltas gather as live text until the message settles', () => {
    const live = fold([stream('hel'), stream('lo')], emptyConversation)
    expect(live.live).toBe('hello')
    const settled = applyEvent(
      live,
      session('assistant/message', {
        provider: 'stub',
        model: 'm',
        content: [{ type: 'text', text: 'hello' }],
        stream: [],
      }),
    )
    expect(settled.live).toBe('')
    expect(settled.blocks).toEqual([{ kind: 'assistant', text: 'hello' }])
  })

  test('a tool call becomes a running block and the result settles it', () => {
    const state = fold([
      session('tool/call', { callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }),
      session('tool/result', {
        callId: 'c1',
        isError: false,
        content: [{ type: 'text', text: 'line one\nline two' }],
      }),
      session('tool/call', { callId: 'c2', name: 'bash', arguments: '{}' }),
      session('tool/result', {
        callId: 'c2',
        isError: true,
        content: [{ type: 'text', text: 'boom' }],
      }),
    ])
    expect(state.blocks).toEqual([
      {
        kind: 'tool',
        callId: 'c1',
        name: 'read',
        summary: '{"path":"a.ts"}',
        status: 'done',
        result: 'line one',
        output: 'line one\nline two',
      },
      {
        kind: 'tool',
        callId: 'c2',
        name: 'bash',
        summary: '{}',
        status: 'error',
        result: 'boom',
        output: 'boom',
      },
    ])
  })

  test('a result longer than a page is capped so the view stays bounded', () => {
    const state = fold([
      session('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }),
      session('tool/result', {
        callId: 'c1',
        isError: false,
        content: [{ type: 'text', text: 'x'.repeat(20_000) }],
      }),
    ])
    const block = state.blocks[0]
    if (block?.kind !== 'tool') throw new Error('the result did not settle the call')
    expect(block.output.length).toBe(16_384)
    expect(block.output.endsWith('…')).toBe(true)
  })

  test('an approval is pending only while its turn runs', () => {
    const running = fold([
      session('turn/start', { turn: 1 }),
      session('safety/approval/requested', {
        callId: 'c1',
        tool: 'bash',
        reason: 'outside the preset',
      }),
    ])
    expect(running.approval).toEqual({ callId: 'c1', tool: 'bash', reason: 'outside the preset' })
    const ended = applyEvent(
      running,
      session('turn/end', { turn: 1, reason: { kind: 'cancelled', cause: 'user' } }),
    )
    expect(ended.approval).toBeUndefined()
  })

  test('a question is pending until it is answered', () => {
    const asked = fold([
      session('interaction/ask/requested', { id: 'a1', question: 'which?', options: ['x'] }),
    ])
    expect(asked.ask).toEqual({ id: 'a1', question: 'which?', options: ['x'] })
    expect(asked.blocks).toEqual([
      { kind: 'ask', id: 'a1', question: 'which?', options: ['x'], answer: undefined },
    ])
    const answered = applyEvent(
      asked,
      session('interaction/ask/answered', { id: 'a1', answer: 'x' }),
    )
    expect(answered.ask).toBeUndefined()
    expect(answered.blocks[0]).toEqual({
      kind: 'ask',
      id: 'a1',
      question: 'which?',
      options: ['x'],
      answer: 'x',
    })
    // An answer to a question nobody asked leaves the log alone.
    expect(
      applyEvent(answered, session('interaction/ask/answered', { id: 'other', answer: 'y' }))
        .blocks,
    ).toEqual(answered.blocks)
  })

  test('a turn failure leaves an error notice', () => {
    const state = fold([
      session('turn/start', { turn: 1 }),
      session('turn/end', {
        turn: 1,
        reason: { kind: 'error', failure: { code: 'PROVIDER', message: 'it broke' } },
      }),
    ])
    expect(state.blocks).toEqual([{ kind: 'notice', level: 'error', text: 'PROVIDER: it broke' }])
  })

  test('a turn cut off by the token cap leaves a warning notice', () => {
    const state = fold([
      session('turn/start', { turn: 1 }),
      session('turn/end', { turn: 1, reason: { kind: 'max-tokens' } }),
    ])
    expect(state.blocks).toEqual([
      { kind: 'notice', level: 'warn', text: 'the answer reached the token cap' },
    ])
  })

  test('injected and runtime context messages are not shown as user input', () => {
    const state = fold([
      session('user/message', { text: 'hidden', source: 'inject' }),
      session('user/message', { text: 'shown', source: 'user' }),
    ])
    expect(state.blocks).toEqual([{ kind: 'user', text: 'shown' }])
  })
})
