/** The A/B's printed result: one line per run, then one line per harness and task. */

import type { AbMetrics } from './metrics.ts'

export interface Cell {
  readonly harness: 'jozo-harness' | 'dsh'
  readonly task: string
  readonly repeat: number
  readonly code: number | undefined
  readonly done: boolean
  readonly metrics: AbMetrics | undefined
  readonly note: string | undefined
}

/** One line per cell run, with the run number so repeats stay visible. */
const cellLine = (cell: Cell): string => {
  const metrics = cell.metrics
  const columns = [
    cell.harness,
    cell.task,
    String(cell.repeat + 1),
    cell.done ? 'yes' : 'no',
    metrics === undefined ? '-' : String(metrics.toolCalls),
    metrics === undefined ? '-' : String(metrics.failedEdits),
    metrics === undefined ? '-' : String(metrics.reReads),
    metrics === undefined ? '-' : String(metrics.turns),
    metrics === undefined ? '-' : String(metrics.steps),
    metrics === undefined ? '-' : String(metrics.outputTokens),
    metrics === undefined ? '-' : String(metrics.compactions),
    cell.code === undefined ? '-' : String(cell.code),
    cell.note ?? '',
  ]
  return '| ' + columns.join(' | ') + ' |'
}

/**
 * Runs of one harness and task, as the numbers they produced. A run whose log
 * could not be counted has no numbers, so `counted` says how many runs the
 * spans come from; `runs` alone would let two runs read as three.
 */
const summaryLine = (group: ReadonlyArray<Cell>): string => {
  const numbers = group.flatMap((cell) => (cell.metrics === undefined ? [] : [cell.metrics]))
  const span = (values: ReadonlyArray<number>): string => {
    if (values.length === 0) return '-'
    const low = Math.min(...values)
    const high = Math.max(...values)
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    return low === high
      ? String(low)
      : String(low) + '-' + String(high) + ' (' + mean.toFixed(1) + ')'
  }
  const columns = [
    group[0]?.harness ?? '',
    group[0]?.task ?? '',
    String(group.length),
    String(numbers.length),
    String(group.filter((cell) => cell.done).length),
    span(numbers.map((metrics) => metrics.toolCalls)),
    span(numbers.map((metrics) => metrics.failedEdits)),
    span(numbers.map((metrics) => metrics.reReads)),
    span(numbers.map((metrics) => metrics.turns)),
    span(numbers.map((metrics) => metrics.steps)),
    span(numbers.map((metrics) => metrics.outputTokens)),
    span(numbers.map((metrics) => metrics.compactions)),
  ]
  return '| ' + columns.join(' | ') + ' |'
}

/** Every run, then each group of runs summed up; `groups` sets the summary's order. */
export const tableOf = (
  cells: ReadonlyArray<Cell>,
  groups: ReadonlyArray<ReadonlyArray<Cell>>,
): string =>
  [
    '| harness | task | run | done | tool calls | failed edits | re-reads | turns | steps | output tokens | compactions | exit | note |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...cells.map(cellLine),
    '',
    '| harness | task | runs | counted | done | tool calls | failed edits | re-reads | turns | steps | output tokens | compactions |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...groups.map(summaryLine),
    '',
  ].join('\n')
