import {
  expandAssistantStream,
  type AssistantStreamRecord,
  type LlmUsage,
  type StreamChunk,
} from '@jozo-harness/llm'
import type { SessionEvent } from './events.ts'
import { meterOf, type TokenBudget, type TokenMeterSource } from './token-meter.ts'

/** What the log counted across every request that reported usage. */
export interface UsageTotals {
  /** Prompt tokens that were not served from or written to the provider's cache. */
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** The answer, reasoning included. */
  readonly outputTokens: number
  readonly reasoningTokens: number
  /** How many assistant messages carried usage. */
  readonly requests: number
  /**
   * Whether every counted request reported cache buckets. One request that stayed
   * silent makes the rate unknown rather than letting the others speak for it.
   */
  readonly cacheReported: boolean
}

/** The numbers a turn or a whole log can state about its token use. */
export interface UsageStats {
  readonly totals: UsageTotals
  /** Output tokens over the newest turn's decode window; undefined without timings. */
  readonly tokensPerSecond: number | undefined
  /** Cache reads over billed input across the log; undefined without complete cache data. */
  readonly cacheHitRate: number | undefined
}

/** The request estimate and the line compaction fires on, with the window they measure. */
export interface ContextStats {
  readonly estimated: number
  readonly threshold: number
  readonly contextWindow: number
  readonly source: TokenMeterSource
}

/** One line of stats, already rounded for a reader; a missing number is an em dash. */
export interface StatsView {
  readonly tokensPerSecond: string
  readonly tokens: string
  readonly cache: string
  readonly context: string
}

const DASH = '—'

interface MutableTotals {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  requests: number
  cacheReports: number
}

const emptyTotals = (): MutableTotals => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  requests: 0,
  cacheReports: 0,
})

const addUsage = (totals: MutableTotals, usage: LlmUsage): void => {
  totals.inputTokens += usage.inputTokens
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0
  totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  totals.outputTokens += usage.outputTokens
  totals.reasoningTokens += usage.reasoningTokens ?? 0
  totals.requests += 1
  if (usage.cacheReadTokens !== undefined) totals.cacheReports += 1
}

const snapshotOf = (totals: MutableTotals): UsageTotals => ({
  inputTokens: totals.inputTokens,
  cacheReadTokens: totals.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens,
  outputTokens: totals.outputTokens,
  reasoningTokens: totals.reasoningTokens,
  requests: totals.requests,
  cacheReported: totals.requests > 0 && totals.cacheReports === totals.requests,
})

/** The prompt tokens the provider billed: uncached input plus both cache buckets. */
export const billedInputTokens = (totals: UsageTotals): number =>
  totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens

/** Cache reads over billed input. No complete cache report, or no input, means unknown. */
export const cacheHitRateOf = (totals: UsageTotals): number | undefined => {
  if (!totals.cacheReported) return undefined
  const billed = billedInputTokens(totals)
  return billed === 0 ? undefined : totals.cacheReadTokens / billed
}

/** How many tokens a decode window produced per second; zero output or time is unknown. */
export const tokensPerSecondOf = (outputTokens: number, decodeMs: number): number | undefined =>
  outputTokens <= 0 || decodeMs <= 0 ? undefined : outputTokens / (decodeMs / 1000)

const isDelta = (chunk: StreamChunk): boolean =>
  chunk.type === 'text-delta' ||
  chunk.type === 'reasoning-delta' ||
  chunk.type === 'tool-call-delta'

/**
 * The span from the first generated token to the last, in the recorded stream.
 * Compact records carry their own gaps, so expanding them recovers every boundary.
 */
const decodeMsOf = (stream: ReadonlyArray<AssistantStreamRecord>): number => {
  let first: number | undefined = undefined
  let last: number | undefined = undefined
  for (const timed of expandAssistantStream(stream)) {
    if (!isDelta(timed.chunk)) continue
    first ??= timed.time
    last = timed.time
  }
  return first === undefined || last === undefined ? 0 : Math.max(0, last - first)
}

/**
 * Folds the usage the log recorded into session totals and the newest turn's rate.
 * The log is append-only, so the newest turn is the one since the last turn/start.
 */
export const usageStatsOf = (events: ReadonlyArray<SessionEvent>): UsageStats => {
  const totals = emptyTotals()
  let newestTurn = emptyTotals()
  let decodeMs = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      newestTurn = emptyTotals()
      decodeMs = 0
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      addUsage(totals, event.data.usage)
      addUsage(newestTurn, event.data.usage)
      decodeMs += decodeMsOf(event.data.stream)
    }
  }
  return {
    totals: snapshotOf(totals),
    tokensPerSecond: tokensPerSecondOf(newestTurn.outputTokens, decodeMs),
    cacheHitRate: cacheHitRateOf(snapshotOf(totals)),
  }
}

/** A number shortened the way a stat pill reads it; a thousand becomes 1.0k. */
export const tokenCountText = (value: number): string => {
  const rounded = Math.max(0, Math.round(value))
  if (rounded < 1_000) return String(rounded)
  if (rounded < 1_000_000) {
    const thousands = rounded / 1_000
    if (thousands >= 999.5) return '1.0M'
    return (thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))) + 'k'
  }
  const millions = rounded / 1_000_000
  return (millions < 10 ? millions.toFixed(1) : String(Math.round(millions))) + 'M'
}

/** Below ten keeps one decimal; above it rounds to a whole number. */
export const tokensPerSecondText = (value: number | undefined): string => {
  if (value === undefined || !Number.isFinite(value)) return DASH
  if (value < 10) {
    const shown = value.toFixed(1)
    // 9.96 rounds up into the integer band rather than reading as "10.0".
    return shown === '10.0' ? '10' : shown
  }
  return String(Math.round(value))
}

/** A partial hit is floored, so 99.9% never reads as a full cache hit. */
export const cacheRateText = (rate: number | undefined): string => {
  if (rate === undefined || !Number.isFinite(rate)) return DASH
  const percent = Math.min(100, Math.max(0, Math.floor(rate * 100)))
  return String(percent) + '%'
}

/** The estimate and threshold the loop compacts on, measured against the same window. */
export const contextStatsOf = (
  events: ReadonlyArray<SessionEvent>,
  budget: TokenBudget,
): ContextStats => {
  const meter = meterOf(events, budget)
  return {
    estimated: meter.estimated,
    threshold: meter.threshold,
    contextWindow: budget.contextWindow,
    source: meter.source,
  }
}

/** The estimate as a share of the window, with the source of the estimate beside it. */
export const contextRateText = (context: ContextStats): string => {
  const ratio = context.contextWindow <= 0 ? 0 : context.estimated / context.contextWindow
  return String(Math.max(0, Math.floor(ratio * 100))) + '% (' + context.source + ')'
}

const tokensTextOf = (totals: UsageTotals): string => {
  if (totals.requests === 0) return DASH
  const input = tokenCountText(totals.inputTokens)
  const output = tokenCountText(totals.outputTokens)
  if (!totals.cacheReported) return input + ' in · ' + output + ' out'
  return (
    input +
    ' in · ' +
    tokenCountText(totals.cacheReadTokens) +
    ' cache read · ' +
    tokenCountText(totals.cacheWriteTokens) +
    ' cache write · ' +
    output +
    ' out · ' +
    tokenCountText(billedInputTokens(totals)) +
    ' billed'
  )
}

/** Everything a status line shows, from the log alone and, when known, the loop's budget. */
export const statsViewOf = (
  events: ReadonlyArray<SessionEvent>,
  budget?: TokenBudget,
): StatsView => {
  const stats = usageStatsOf(events)
  const context = budget === undefined ? undefined : contextStatsOf(events, budget)
  return {
    tokensPerSecond: tokensPerSecondText(stats.tokensPerSecond),
    tokens: tokensTextOf(stats.totals),
    cache: cacheRateText(stats.cacheHitRate),
    context: context === undefined ? DASH : contextRateText(context),
  }
}

/** The four parts in the order a reader takes them. */
export const statsLineTextOf = (view: StatsView): string =>
  'tok/s ' +
  view.tokensPerSecond +
  ' · ' +
  view.tokens +
  ' · cache ' +
  view.cache +
  ' · context ' +
  view.context
