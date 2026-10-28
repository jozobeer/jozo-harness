import { describe, expect, test } from 'vitest'
import { shortenTitle, titleOf, type SessionEvent } from '../src/index.ts'

const firstMessage = (text: string): SessionEvent => ({
  seq: 1,
  time: 1,
  type: 'user/message',
  data: { text, source: 'user' },
})

const sessionTitle = (
  title: string,
  source: 'model' | 'human' | 'fallback',
  seq: number,
): SessionEvent => ({ seq, time: seq, type: 'session/title', data: { title, source } })

describe('the name a session folds to', () => {
  test('a model name replaces the cut first message', () => {
    const first = 'please fix the flaky login test that only fails on CI sometimes'
    const events = [firstMessage(first), sessionTitle('flaky login test', 'model', 2)]
    expect(titleOf(events)).toBe('flaky login test')
    expect(titleOf(events)).not.toBe(shortenTitle(first))
  })

  test('a human name written after the model name wins', () => {
    const events = [
      firstMessage('count the files'),
      sessionTitle('counting files', 'model', 2),
      sessionTitle('my own name', 'human', 3),
    ]
    expect(titleOf(events)).toBe('my own name')
  })

  test('a human name written before the model name still wins', () => {
    const events = [
      firstMessage('count the files'),
      sessionTitle('my own name', 'human', 2),
      sessionTitle('counting files', 'model', 3),
    ]
    expect(titleOf(events)).toBe('my own name')
  })

  test('a fallback holds the first message until a model name arrives', () => {
    const first = 'count the files'
    expect(titleOf([firstMessage(first), sessionTitle(shortenTitle(first), 'fallback', 2)])).toBe(
      first,
    )
    expect(
      titleOf([
        firstMessage(first),
        sessionTitle(shortenTitle(first), 'fallback', 2),
        sessionTitle('counting files', 'model', 3),
      ]),
    ).toBe('counting files')
  })
})
