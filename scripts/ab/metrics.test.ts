import { describe, expect, test } from 'vitest'
import { dshMetrics, jozoHarnessMetrics } from './metrics.ts'

/** The two shapes, as the logs actually carry them. */
const jozoHarnessEvents = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'assistant/message', data: { usage: { inputTokens: 900, outputTokens: 120 } } },
  { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"src/a.ts"}' } },
  { type: 'tool/result', data: { callId: 'c1', isError: false } },
  { type: 'tool/call', data: { callId: 'c2', name: 'read', arguments: '{"path":"src/a.ts"}' } },
  { type: 'tool/result', data: { callId: 'c2', isError: false } },
  { type: 'assistant/message', data: { usage: { inputTokens: 940, outputTokens: 30 } } },
  { type: 'tool/call', data: { callId: 'c3', name: 'edit', arguments: '{"path":"src/a.ts"}' } },
  { type: 'tool/result', data: { callId: 'c3', isError: true } },
]

const dshEvents = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'assistant/message', data: { usage: { inputTokens: 700, outputTokens: 80 } } },
  {
    type: 'tool/call',
    data: { callId: 'd1', name: 'read', arguments: '{"file_path":"src/b.ts"}' },
  },
  { type: 'tool/result', data: { message: { toolCallId: 'd1', isError: false } } },
  {
    type: 'tool/call',
    data: { callId: 'd2', name: 'read', arguments: '{"file_path":"src/b.ts"}' },
  },
  { type: 'tool/result', data: { message: { toolCallId: 'd2', isError: false } } },
  { type: 'assistant/message', data: { usage: { inputTokens: 760, outputTokens: 20 } } },
  { type: 'tool/call', data: { callId: 'd3', name: 'edit', arguments: '{"path":"src/b.ts"}' } },
  { type: 'tool/result', data: { message: { toolCallId: 'd3', isError: true } } },
]

describe('the A/B counters', () => {
  test('count the same story from the jozo-harness log', () => {
    const metrics = jozoHarnessMetrics(jozoHarnessEvents)

    expect(metrics.toolCalls).toBe(3)
    expect(metrics.reReads).toBe(1)
    expect(metrics.failedEdits).toBe(1)
    expect(metrics.turns).toBe(1)
    expect(metrics.steps).toBe(2)
    expect(metrics.outputTokens).toBe(150)
    expect(metrics.tools['read']).toBe(2)
  })

  test('count the same story from the dsh log', () => {
    const metrics = dshMetrics(dshEvents)

    expect(metrics.toolCalls).toBe(3)
    expect(metrics.reReads).toBe(1)
    expect(metrics.failedEdits).toBe(1)
    expect(metrics.turns).toBe(1)
    expect(metrics.steps).toBe(2)
    expect(metrics.outputTokens).toBe(100)
    expect(metrics.tools['edit']).toBe(1)
  })

  test('a failed edit is not counted as a re-read, and other failures are not edits', () => {
    const metrics = jozoHarnessMetrics([
      { type: 'tool/call', data: { callId: 'x', name: 'read', arguments: '{"path":"a"}' } },
      { type: 'tool/result', data: { callId: 'x', isError: true } },
      { type: 'tool/call', data: { callId: 'y', name: 'read', arguments: '{"path":"a"}' } },
      { type: 'tool/result', data: { callId: 'y', isError: false } },
    ])

    expect(metrics.failedEdits).toBe(0)
    expect(metrics.reReads).toBe(1)
  })

  test('a settled message without usage still counts its round trip', () => {
    const metrics = jozoHarnessMetrics([{ type: 'assistant/message', data: { content: [] } }])

    expect(metrics.steps).toBe(1)
    expect(metrics.outputTokens).toBe(0)
  })

  test('count the summaries each harness wrote when the context ran out', () => {
    const jozoHarness = jozoHarnessMetrics([
      { type: 'compaction/checkpoint', data: { summary: 'one' } },
      { type: 'compaction/prune', data: {} },
      { type: 'compaction/checkpoint', data: { summary: 'two' } },
    ])
    const dsh = dshMetrics([
      { type: 'compaction/start', data: {} },
      { type: 'compaction/summary', data: { summary: 'one' } },
      { type: 'compaction/end', data: {} },
      { type: 'compaction/checkpoint', data: { summary: 'not a dsh summary' } },
    ])

    expect(jozoHarness.compactions).toBe(2)
    expect(dsh.compactions).toBe(1)
    expect(jozoHarnessMetrics(jozoHarnessEvents).compactions).toBe(0)
  })

  test('a read whose path cannot be found stops the count instead of reading as no re-read', () => {
    const readOf = (args: string) => [
      { type: 'tool/call', data: { callId: 'r1', name: 'read', arguments: args } },
      { type: 'tool/call', data: { callId: 'r2', name: 'read', arguments: args } },
    ]

    expect(() => jozoHarnessMetrics(readOf('{"filename":"src/a.ts"}'))).toThrow(
      'read without a path: {"filename":"src/a.ts"}',
    )
    expect(() => dshMetrics(readOf('{"file_path":'))).toThrow('read without a path: {"file_path":')
  })
})
