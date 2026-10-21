import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { decodeSessionEvent, type SessionEvent } from '../src/index.ts'
import { event, headerEvent } from './support.ts'

const throughJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const decode = (value: unknown): Promise<SessionEvent | undefined> =>
  Effect.runPromise(decodeSessionEvent(value))
const decodeError = (value: unknown) => Effect.runPromise(Effect.flip(decodeSessionEvent(value)))

describe('decodeSessionEvent', () => {
  test('round-trips a simple event', async () => {
    const sessionEvent = event(2, 'user/message', { text: crypto.randomUUID(), source: 'user' })
    expect(await decode(throughJson(sessionEvent))).toEqual(sessionEvent)
  })

  test('round-trips nested content and a compact stream', async () => {
    const callId = crypto.randomUUID()
    const sessionEvent = event(2, 'assistant/message', {
      provider: 'ollama-cloud',
      model: 'qwen3-coder:480b',
      content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
      stream: [
        { type: 'chunk', time: 5, chunk: { type: 'finish', kind: 'stop' } },
        { type: 'text-chunks', time0: 1, index: 0, dt: [2], texts: ['a', 'b'] },
      ],
    })

    expect(await decode(throughJson(sessionEvent))).toEqual(sessionEvent)
  })

  test('round-trips a turn ended by the token cap', async () => {
    const sessionEvent = event(2, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    expect(await decode(throughJson(sessionEvent))).toEqual(sessionEvent)
  })

  test('round-trips a header', async () => {
    expect(await decode(throughJson(headerEvent()))).toEqual(headerEvent())
  })

  test('round-trips the file changes a tool recorded', async () => {
    const diffs = [
      { path: '/work/a.txt', oldStart: 2, newStart: 2, removed: ['old'], added: ['new'] },
    ]
    const sessionEvent = event(2, 'tool/result', {
      callId: 'c1',
      isError: false,
      content: [{ type: 'text', text: 'edited' }],
      diffs,
    })

    expect(await decode(throughJson(sessionEvent))).toEqual(sessionEvent)
  })

  test('reads a result written before diffs existed', async () => {
    const sessionEvent = event(2, 'tool/result', {
      callId: 'c1',
      isError: false,
      content: [{ type: 'text', text: 'edited' }],
    })

    expect(await decode(throughJson(sessionEvent))).toEqual(sessionEvent)
  })

  test('rejects a malformed envelope', async () => {
    const error = await decodeError({ seq: 'two', time: 1, type: 'user/message', data: {} })
    expect(error.code).toBe('persistence')
    expect(error.message).toContain('envelope')
  })

  test('rejects a known type whose data does not match', async () => {
    const error = await decodeError({ seq: 2, time: 3, type: 'user/message', data: { text: 'hi' } })
    expect(error.code).toBe('persistence')
    expect(error.message).toContain('user/message')
  })

  test('rejects an unknown type without ignorable', async () => {
    const error = await decodeError({ seq: 2, time: 3, type: 'plugin/unknown', data: {} })
    expect(error.code).toBe('persistence')
    expect(error.message).toContain('plugin/unknown')
  })

  test('skips an unknown type that marks itself ignorable', async () => {
    expect(
      await decode({ seq: 2, time: 3, type: 'plugin/unknown', data: {}, ignorable: true }),
    ).toBeUndefined()
  })
})
