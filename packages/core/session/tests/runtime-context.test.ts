import { describe, expect, test } from 'vitest'
import { lastRuntimeContext, lastRuntimeContextSeq } from '../src/index.ts'
import { event } from './support.ts'

describe('lastRuntimeContext', () => {
  test('is undefined before any snapshot', () => {
    expect(lastRuntimeContext([])).toBeUndefined()
  })

  test('returns the newest snapshot, not the newest user message', () => {
    const events = [
      event(2, 'user/message', { text: 'first', source: 'runtime-context' }),
      event(3, 'user/message', { text: 'do the task', source: 'user' }),
      event(4, 'user/message', { text: 'second', source: 'runtime-context' }),
      event(5, 'assistant/message', {
        provider: 'p',
        model: 'm',
        content: [],
        stream: [],
      }),
    ]

    expect(lastRuntimeContext(events)).toBe('second')
  })

  test('an injected message is not a snapshot', () => {
    const events = [event(2, 'user/message', { text: 'note', source: 'inject' })]

    expect(lastRuntimeContext(events)).toBeUndefined()
  })

  test('a snapshot a checkpoint shadowed no longer speaks for the session', () => {
    const events = [
      event(2, 'user/message', { text: 'old', source: 'runtime-context' }),
      event(3, 'compaction/checkpoint', {
        shadowedSeqs: [2],
        shadowedRange: { start: 2, end: 2 },
        summary: 'what happened before',
        provider: 'p',
        model: 'm',
      }),
      event(4, 'user/message', { text: 'do the task', source: 'user' }),
    ]

    // The loop must append a fresh snapshot rather than trust a folded one.
    expect(lastRuntimeContext(events)).toBeUndefined()
    expect(lastRuntimeContextSeq(events)).toBeUndefined()
  })

  test('a newer snapshot after the checkpoint is the one that speaks', () => {
    const events = [
      event(2, 'user/message', { text: 'old', source: 'runtime-context' }),
      event(3, 'compaction/checkpoint', {
        shadowedSeqs: [2],
        shadowedRange: { start: 2, end: 2 },
        summary: 'what happened before',
        provider: 'p',
        model: 'm',
      }),
      event(4, 'user/message', { text: 'new', source: 'runtime-context' }),
    ]

    expect(lastRuntimeContext(events)).toBe('new')
    expect(lastRuntimeContextSeq(events)).toBe(4)
  })
})
