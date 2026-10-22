import { describe, expect, test } from 'vitest'
import { formatTurnReport, turnMetricsOf } from './turn-metrics.ts'

const line = (time: number, type: string, data: Record<string, unknown>): string =>
  JSON.stringify({ seq: time, time, type, data })

/**
 * Two turns as a real log writes them: the model answers inside a step, tools run
 * in that step, the step closes. Turn 1's second step crosses the large-answer
 * line; turn 2 has a single step. A header and a torn line must not disturb it.
 */
const syntheticLog = [
  line(0, 'turn/start', { turn: 1 }),
  line(0, 'step/start', { step: 1 }),
  line(2000, 'assistant/message', {
    provider: 'p',
    model: 'm',
    content: [],
    stream: [],
    usage: { inputTokens: 10, outputTokens: 100 },
  }),
  line(2500, 'tool/call', { callId: 'c1', name: 'read', arguments: '{}' }),
  line(3500, 'tool/result', { callId: 'c1', isError: false, content: [] }),
  line(4000, 'step/end', { step: 1 }),
  line(5000, 'step/start', { step: 2 }),
  line(8000, 'assistant/message', {
    provider: 'p',
    model: 'm',
    content: [],
    stream: [],
    usage: { inputTokens: 10, outputTokens: 4000, reasoningTokens: 40 },
  }),
  line(9000, 'step/end', { step: 2 }),
  line(10000, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  line(11000, 'turn/start', { turn: 2 }),
  line(11000, 'step/start', { step: 1 }),
  line(12000, 'assistant/message', {
    provider: 'p',
    model: 'm',
    content: [],
    stream: [],
    usage: { inputTokens: 10, outputTokens: 50 },
  }),
  line(12100, 'tool/call', { callId: 'c2', name: 'bash', arguments: '{}' }),
  line(12400, 'tool/result', { callId: 'c2', isError: false, content: [] }),
  line(13000, 'step/end', { step: 1 }),
  line(13100, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  line(13200, 'session/header', { formatVersion: 1 }),
  'not json',
].join('\n')

describe('turn metrics', () => {
  test('count round trips, tool time, and output tokens per turn', () => {
    const first = turnMetricsOf(syntheticLog).turns[0]

    expect(first?.turn).toBe(1)
    expect(first?.steps).toBe(2)
    expect(first?.toolCalls).toBe(1)
    expect(first?.modelSeconds).toBe(7)
    expect(first?.toolSeconds).toBe(1)
    expect(first?.outputTokens).toBe(4100)
    expect(first?.reasoningTokens).toBe(40)
    expect(first?.correlation).toBe(1)
  })

  test('subtract tool time from the step it ran in', () => {
    const second = turnMetricsOf(syntheticLog).turns[1]

    expect(second?.turn).toBe(2)
    expect(second?.steps).toBe(1)
    expect(second?.toolCalls).toBe(1)
    expect(second?.modelSeconds).toBe(1.7)
    expect(second?.toolSeconds).toBe(0.3)
    expect(second?.correlation).toBeUndefined()
  })

  test('sum the turns and correlate across every step', () => {
    const total = turnMetricsOf(syntheticLog).total

    expect(total.steps).toBe(3)
    expect(total.toolCalls).toBe(2)
    expect(total.modelSeconds).toBeCloseTo(8.7, 10)
    expect(total.toolSeconds).toBeCloseTo(1.3, 10)
    expect(total.outputTokens).toBe(4150)
    expect(total.reasoningTokens).toBe(40)
    expect(total.correlation).toBeCloseTo(0.832, 3)
  })

  test('count the steps that crossed 4000 output tokens and sum their time', () => {
    const report = turnMetricsOf(syntheticLog)

    expect(report.largeSteps).toBe(1)
    expect(report.largeModelSeconds).toBe(4)
  })

  test('print one row per turn and a total line', () => {
    const text = formatTurnReport(turnMetricsOf(syntheticLog))

    expect(text).toContain('| turn | steps | toolCalls |')
    expect(text).toContain('| 1 | 2 | 1 | 7.000 | 1.000 | 4100 | 40 | 1.000 |')
    expect(text).toContain('| total | 3 | 2 | 8.700 | 1.300 | 4150 | 40 | 0.832 |')
    expect(text).toContain('large steps (>= 4000 output tokens): 1, model seconds 4.000')
  })

  test('read a log that ends mid-step without dropping the turn', () => {
    const report = turnMetricsOf(
      [
        line(0, 'turn/start', { turn: 1 }),
        line(0, 'step/start', { step: 1 }),
        line(1000, 'assistant/message', { usage: { outputTokens: 10 } }),
      ].join('\n'),
    )

    expect(report.turns).toHaveLength(1)
    expect(report.total.modelSeconds).toBe(1)
    expect(report.total.outputTokens).toBe(10)
  })

  test('an empty log reports zeros and no correlation', () => {
    const report = turnMetricsOf('')

    expect(report.turns).toEqual([])
    expect(report.total.steps).toBe(0)
    expect(report.total.correlation).toBeUndefined()
  })
})
