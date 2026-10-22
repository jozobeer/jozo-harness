/**
 * What a session's turns cost: how many model round trips each turn held, how
 * long the model spent against how long tools ran, and how much output the model
 * wrote. The time a model spends answering is the step's wall time minus the
 * tool calls that ran inside it, so the two totals add up to the step and a turn
 * shows where its time went. Output tokens are paired with that per-step model
 * time for a Pearson coefficient: an answer twice as long should take about
 * twice as long, and a coefficient that drifts from that says the prompt, not the
 * output, is where the turn's time goes.
 */

import { readFileSync } from 'node:fs'

/** A step this big is the answer that makes a turn slow, not its tools. */
const LARGE_STEP_TOKENS = 4000

export interface TurnMetrics {
  readonly turn: number
  /** Model round trips: one settled `assistant/message` per request. */
  readonly steps: number
  readonly toolCalls: number
  /** Step wall time minus the tool calls that ran inside each step. */
  readonly modelSeconds: number
  readonly toolSeconds: number
  readonly outputTokens: number
  /** The reasoning share providers report separately; included in `outputTokens` when they report it. */
  readonly reasoningTokens: number
  /** Pearson coefficient over the turn's steps; absent when there is no spread to correlate. */
  readonly correlation?: number
}

export interface TurnReport {
  readonly turns: ReadonlyArray<TurnMetrics>
  readonly total: TurnMetrics
  readonly largeSteps: number
  readonly largeModelSeconds: number
}

interface LogEvent {
  readonly time: number
  readonly type: string
  readonly data: Record<string, unknown>
}

interface OpenStep {
  readonly startedAt: number
  toolSeconds: number
  outputTokens: number
}

interface Accumulator {
  readonly turn: number
  steps: number
  toolCalls: number
  modelSeconds: number
  toolSeconds: number
  outputTokens: number
  reasoningTokens: number
  readonly pairs: Array<readonly [number, number]>
}

/** The fold's mutable state, kept out of the event handlers so each stays small. */
interface Fold {
  readonly turns: Array<TurnMetrics>
  readonly callTimes: Map<string, number>
  readonly pairs: Array<readonly [number, number]>
  current: Accumulator | undefined
  open: OpenStep | undefined
  lastTime: number
  largeSteps: number
  largeModelSeconds: number
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const numberOf = (record: Record<string, unknown> | undefined, key: string): number => {
  const value = record?.[key]
  return typeof value === 'number' ? value : 0
}

/** Lines that are not a session event (a torn tail, another writer's file) are skipped. */
const eventsOf = (text: string): ReadonlyArray<LogEvent> =>
  text.split('\n').flatMap((raw) => {
    if (raw.trim() === '') return []
    try {
      const parsed = asRecord(JSON.parse(raw) as unknown)
      const type = parsed?.['type']
      const time = parsed?.['time']
      const data = asRecord(parsed?.['data'])
      if (typeof type !== 'string' || typeof time !== 'number' || data === undefined) return []
      return [{ time, type, data }]
    } catch {
      return []
    }
  })

/** Population Pearson coefficient; a single point or a flat series has none. */
export const pearsonOf = (pairs: ReadonlyArray<readonly [number, number]>): number | undefined => {
  if (pairs.length < 2) return undefined
  const count = pairs.length
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / count
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / count
  let covariance = 0
  let varianceX = 0
  let varianceY = 0
  for (const [x, y] of pairs) {
    covariance += (x - meanX) * (y - meanY)
    varianceX += (x - meanX) ** 2
    varianceY += (y - meanY) ** 2
  }
  const denominator = Math.sqrt(varianceX * varianceY)
  return denominator === 0 ? undefined : covariance / denominator
}

const settled = (accumulator: Accumulator): TurnMetrics => {
  const correlation = pearsonOf(accumulator.pairs)
  return {
    turn: accumulator.turn,
    steps: accumulator.steps,
    toolCalls: accumulator.toolCalls,
    modelSeconds: accumulator.modelSeconds,
    toolSeconds: accumulator.toolSeconds,
    outputTokens: accumulator.outputTokens,
    reasoningTokens: accumulator.reasoningTokens,
    ...(correlation === undefined ? {} : { correlation }),
  }
}

const emptyAccumulator = (turn: number): Accumulator => ({
  turn,
  steps: 0,
  toolCalls: 0,
  modelSeconds: 0,
  toolSeconds: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  pairs: [],
})

const closeStep = (fold: Fold, at: number): void => {
  const step = fold.open
  const current = fold.current
  if (step === undefined || current === undefined) return
  const modelSeconds = Math.max(0, (at - step.startedAt) / 1000 - step.toolSeconds)
  current.modelSeconds += modelSeconds
  current.pairs.push([modelSeconds, step.outputTokens])
  fold.pairs.push([modelSeconds, step.outputTokens])
  if (step.outputTokens >= LARGE_STEP_TOKENS) {
    fold.largeSteps += 1
    fold.largeModelSeconds += modelSeconds
  }
  fold.open = undefined
}

/**
 * A turn that never wrote `turn/end` (the run died) is closed at the last event,
 * so a crashed session still reports what it spent instead of reading as zero.
 */
const finishTurn = (fold: Fold, at: number): void => {
  closeStep(fold, at)
  if (fold.current === undefined) return
  fold.turns.push(settled(fold.current))
  fold.current = undefined
  fold.callTimes.clear()
}

const startTurn = (fold: Fold, event: LogEvent): void => {
  finishTurn(fold, event.time)
  fold.current = emptyAccumulator(numberOf(event.data, 'turn'))
}

const startStep = (fold: Fold, event: LogEvent): void => {
  closeStep(fold, event.time)
  if (fold.current !== undefined) {
    fold.open = { startedAt: event.time, toolSeconds: 0, outputTokens: 0 }
  }
}

const applyAssistant = (fold: Fold, event: LogEvent): void => {
  const current = fold.current
  if (current === undefined) return
  current.steps += 1
  const usage = asRecord(event.data['usage'])
  const outputTokens = numberOf(usage, 'outputTokens')
  current.outputTokens += outputTokens
  current.reasoningTokens += numberOf(usage, 'reasoningTokens')
  if (fold.open !== undefined) fold.open.outputTokens += outputTokens
}

const applyToolCall = (fold: Fold, event: LogEvent): void => {
  if (fold.current === undefined) return
  fold.current.toolCalls += 1
  const callId = event.data['callId']
  if (typeof callId === 'string') fold.callTimes.set(callId, event.time)
}

const applyToolResult = (fold: Fold, event: LogEvent): void => {
  const current = fold.current
  const callId = event.data['callId']
  if (current === undefined || typeof callId !== 'string') return
  const startedAt = fold.callTimes.get(callId)
  if (startedAt === undefined) return
  fold.callTimes.delete(callId)
  const seconds = Math.max(0, (event.time - startedAt) / 1000)
  current.toolSeconds += seconds
  if (fold.open !== undefined) fold.open.toolSeconds += seconds
}

const HANDLERS: Readonly<Record<string, (fold: Fold, event: LogEvent) => void>> = {
  'turn/start': startTurn,
  'turn/end': (fold, event) => finishTurn(fold, event.time),
  'step/start': startStep,
  'step/end': (fold, event) => closeStep(fold, event.time),
  'assistant/message': applyAssistant,
  'tool/call': applyToolCall,
  'tool/result': applyToolResult,
}

const sum = (turns: ReadonlyArray<TurnMetrics>, pick: (turn: TurnMetrics) => number): number =>
  turns.reduce((total, turn) => total + pick(turn), 0)

/** Folds the log into a row per turn, then the total the rows add up to. */
export const turnMetricsOf = (text: string): TurnReport => {
  const fold: Fold = {
    turns: [],
    callTimes: new Map<string, number>(),
    pairs: [],
    current: undefined,
    open: undefined,
    lastTime: 0,
    largeSteps: 0,
    largeModelSeconds: 0,
  }
  for (const event of eventsOf(text)) {
    fold.lastTime = event.time
    HANDLERS[event.type]?.(fold, event)
  }
  finishTurn(fold, fold.lastTime)
  const correlation = pearsonOf(fold.pairs)
  const { turns } = fold
  return {
    turns,
    total: {
      turn: 0,
      steps: sum(turns, (turn) => turn.steps),
      toolCalls: sum(turns, (turn) => turn.toolCalls),
      modelSeconds: sum(turns, (turn) => turn.modelSeconds),
      toolSeconds: sum(turns, (turn) => turn.toolSeconds),
      outputTokens: sum(turns, (turn) => turn.outputTokens),
      reasoningTokens: sum(turns, (turn) => turn.reasoningTokens),
      ...(correlation === undefined ? {} : { correlation }),
    },
    largeSteps: fold.largeSteps,
    largeModelSeconds: fold.largeModelSeconds,
  }
}

const coefficient = (value: number | undefined): string =>
  value === undefined ? '-' : value.toFixed(3)

const row = (label: string, metrics: TurnMetrics): string =>
  '| ' +
  [
    label,
    String(metrics.steps),
    String(metrics.toolCalls),
    metrics.modelSeconds.toFixed(3),
    metrics.toolSeconds.toFixed(3),
    String(metrics.outputTokens),
    String(metrics.reasoningTokens),
    coefficient(metrics.correlation),
  ].join(' | ') +
  ' |'

/** The rows a reader pastes into a PR: one per turn, the total, then the large steps. */
export const formatTurnReport = (report: TurnReport): string =>
  [
    '| turn | steps | toolCalls | modelSeconds | toolSeconds | outputTokens | reasoningTokens | r |',
    '|---|---|---|---|---|---|---|---|',
    ...report.turns.map((turn) => row(String(turn.turn), turn)),
    row('total', report.total),
    'large steps (>= ' +
      String(LARGE_STEP_TOKENS) +
      ' output tokens): ' +
      String(report.largeSteps) +
      ', model seconds ' +
      report.largeModelSeconds.toFixed(3),
    '',
  ].join('\n')

const main = (): void => {
  const path = process.argv[2]
  if (path === undefined) {
    process.stderr.write('usage: node scripts/turn-metrics.ts <session.jsonl>\n')
    process.exitCode = 2
    return
  }
  process.stdout.write(formatTurnReport(turnMetricsOf(readFileSync(path, 'utf8'))))
}

if (process.argv[1]?.endsWith('turn-metrics.ts') === true) main()
