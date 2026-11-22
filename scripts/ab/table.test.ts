import { describe, expect, test } from 'vitest'
import type { AbMetrics } from './metrics.ts'
import { tableOf, type Cell } from './table.ts'

const metricsOf = (toolCalls: number, compactions = 0): AbMetrics => ({
  toolCalls,
  failedEdits: 0,
  reReads: 1,
  turns: 1,
  steps: 2,
  outputTokens: 300,
  compactions,
  tools: {},
})

const cellOf = (repeat: number, metrics: AbMetrics | undefined): Cell => ({
  harness: 'jozo-harness',
  task: 'fix-add',
  repeat,
  code: 0,
  done: true,
  metrics,
  note: metrics === undefined ? 'not counted: read without a path: {}' : undefined,
})

const summaryOf = (cells: ReadonlyArray<Cell>): ReadonlyArray<string> =>
  tableOf(cells, [cells]).split('\n').slice(-4, -1)

describe('the A/B summary', () => {
  test('says how many runs its numbers come from', () => {
    const cells = [cellOf(0, metricsOf(3, 2)), cellOf(1, undefined), cellOf(2, metricsOf(5))]

    expect(summaryOf(cells)).toEqual([
      '| harness | task | runs | counted | done | tool calls | failed edits | re-reads | turns | steps | output tokens | compactions |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      '| jozo-harness | fix-add | 3 | 2 | 3 | 3-5 (4.0) | 0 | 1 | 1 | 2 | 300 | 0-2 (1.0) |',
    ])
  })

  test('each run shows its own steps, tokens, and compactions', () => {
    const lines = tableOf([cellOf(0, metricsOf(3, 2))], []).split('\n')

    expect(lines.slice(0, 3)).toEqual([
      '| harness | task | run | done | tool calls | failed edits | re-reads | turns | steps | output tokens | compactions | exit | note |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
      '| jozo-harness | fix-add | 1 | yes | 3 | 0 | 1 | 1 | 2 | 300 | 2 | 0 |  |',
    ])
  })

  test('a group with no counted run shows no numbers', () => {
    const cells = [cellOf(0, undefined), cellOf(1, undefined)]

    expect(summaryOf(cells)[2]).toBe(
      '| jozo-harness | fix-add | 2 | 0 | 2 | - | - | - | - | - | - | - |',
    )
  })
})
