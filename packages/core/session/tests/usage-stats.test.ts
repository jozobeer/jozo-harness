import { describe, expect, test } from 'vitest'
import {
  cacheRateText,
  contextRateText,
  statsLineTextOf,
  statsViewOf,
  tokenCountText,
  tokensPerSecondOf,
  tokensPerSecondText,
  usageStatsOf,
} from '../src/index.ts'
import { event, headerEvent } from './support.ts'

const usage = (
  seq: number,
  inputTokens: number,
  outputTokens: number,
  cache: { readonly read?: number; readonly write?: number } = {},
) =>
  event(seq, 'assistant/message', {
    provider: 'p',
    model: 'm',
    content: [{ type: 'text', text: 'answer' }],
    usage: {
      inputTokens,
      outputTokens,
      ...(cache.read === undefined ? {} : { cacheReadTokens: cache.read }),
      ...(cache.write === undefined ? {} : { cacheWriteTokens: cache.write }),
    },
    stream: [
      { type: 'text-chunks', time0: 1000, index: 0, dt: [500], texts: ['a', 'b'] },
      { type: 'chunk', time: 1600, chunk: { type: 'finish', kind: 'stop' } },
    ],
  })

const turn = (seq: number, number: number) => event(seq, 'turn/start', { turn: number })

describe('usageStatsOf', () => {
  test('sums the logged usage and reads tokens per second from the newest turn decode window', () => {
    const events = [
      headerEvent(),
      turn(2, 1),
      usage(3, 100, 20),
      turn(4, 2),
      usage(5, 1_000, 10, { read: 500, write: 0 }),
    ]

    const stats = usageStatsOf(events)

    expect(stats.totals).toEqual({
      inputTokens: 1_100,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 30,
      reasoningTokens: 0,
      requests: 2,
      cacheReported: false,
    })
    // Only the newest turn counts for the rate: ten output tokens over half a second.
    expect(stats.tokensPerSecond).toBe(20)
    expect(stats.cacheHitRate).toBeUndefined()
  })

  test('reports a cache rate only when every counted request carried cache buckets', () => {
    const events = [
      headerEvent(),
      turn(2, 1),
      usage(3, 300, 10, { read: 700, write: 0 }),
      usage(4, 100, 10, { read: 0, write: 100 }),
    ]

    const stats = usageStatsOf(events)

    expect(stats.cacheHitRate).toBe(700 / 1_200)
  })

  test('a request without cache buckets leaves the rate unknown, not zero', () => {
    const events = [headerEvent(), usage(2, 100, 10, { read: 900, write: 0 }), usage(3, 100, 10)]

    const stats = usageStatsOf(events)

    expect(stats.cacheHitRate).toBeUndefined()
  })

  test('no usage at all stays empty rather than reading as zero', () => {
    const stats = usageStatsOf([headerEvent(), turn(2, 1)])

    expect(stats.totals.requests).toBe(0)
    expect(stats.tokensPerSecond).toBeUndefined()
    expect(stats.cacheHitRate).toBeUndefined()
  })
})

describe('the stat numbers as a reader sees them', () => {
  test('token counts shorten above a thousand', () => {
    expect(tokenCountText(0)).toBe('0')
    expect(tokenCountText(999)).toBe('999')
    expect(tokenCountText(1_000)).toBe('1.0k')
    expect(tokenCountText(1_250)).toBe('1.3k')
    expect(tokenCountText(12_500)).toBe('13k')
    expect(tokenCountText(1_500_000)).toBe('1.5M')
  })

  test('tokens per second keeps a decimal below ten and rounds above it', () => {
    expect(tokensPerSecondText(undefined)).toBe('—')
    expect(tokensPerSecondText(0)).toBe('0.0')
    expect(tokensPerSecondText(9.44)).toBe('9.4')
    expect(tokensPerSecondText(9.96)).toBe('10')
    expect(tokensPerSecondText(12.6)).toBe('13')
  })

  test('a partial cache hit never reads as a hundred percent', () => {
    expect(cacheRateText(undefined)).toBe('—')
    expect(cacheRateText(0)).toBe('0%')
    expect(cacheRateText(0.456)).toBe('45%')
    expect(cacheRateText(0.999)).toBe('99%')
    expect(cacheRateText(1)).toBe('100%')
  })

  test('a rate needs a positive decode span and output', () => {
    expect(tokensPerSecondOf(10, 0)).toBeUndefined()
    expect(tokensPerSecondOf(0, 1_000)).toBeUndefined()
    expect(tokensPerSecondOf(10, 2_000)).toBe(5)
  })

  test('context says which estimate the percentage came from', () => {
    expect(
      contextRateText({ estimated: 100, threshold: 800, contextWindow: 1_000, source: 'bytes' }),
    ).toBe('10% (bytes)')
    expect(
      contextRateText({ estimated: 900, threshold: 800, contextWindow: 1_000, source: 'usage' }),
    ).toBe('90% (usage)')
  })
})

describe('statsViewOf', () => {
  test('formats the usage line from the log and the context from the meter budget', () => {
    const events = [
      headerEvent('/work'),
      event(2, 'user/message', { text: 'x'.repeat(400), source: 'user' }),
      turn(3, 1),
      usage(4, 1_000, 200, { read: 500, write: 0 }),
    ]
    const view = statsViewOf(events, {
      contextWindow: 2_000,
      thresholdRatio: 0.8,
      headroomTokens: 0,
    })

    expect(view.tokensPerSecond).toBe('400')
    expect(view.tokens).toBe('1.0k in · 500 cache read · 0 cache write · 200 out · 1.5k billed')
    expect(view.cache).toBe('33%')
    // 1,000 uncached + 500 cache read + 200 output, over a 2,000 window.
    expect(view.context).toBe('85% (usage)')
    expect(statsLineTextOf(view)).toBe(
      'tok/s 400 · 1.0k in · 500 cache read · 0 cache write · 200 out · 1.5k billed · cache 33% · context 85% (usage)',
    )
  })

  test('a log with nothing counted shows dashes, not zeroes', () => {
    const view = statsViewOf([headerEvent()], {
      contextWindow: 1_000,
      thresholdRatio: 0.8,
      headroomTokens: 0,
    })

    expect(view).toEqual({
      tokensPerSecond: '—',
      tokens: '—',
      cache: '—',
      context: '0% (bytes)',
    })
  })

  test('without a budget the context stays unknown', () => {
    const view = statsViewOf([headerEvent()])

    expect(view.context).toBe('—')
    expect(statsLineTextOf(view)).toBe('tok/s — · — · cache — · context —')
  })
})
