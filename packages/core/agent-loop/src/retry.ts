import type { HookRegistry } from '@jozo-harness/kernel'
import { LLM_FAILURE_CODES, type LlmFailure, type LlmFailureCode } from '@jozo-harness/llm'
import { Effect, Schema, type Scope } from 'effect'
import type { RequestErrorDecision } from './hooks.ts'

/** The codes a provider failure is retried for when the profile says nothing. */
export const DEFAULT_RETRYABLE_CODES: ReadonlyArray<LlmFailureCode> = [
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
]

/** How many times a failed attempt is sent again, and how long the wait grows. */
export const RETRY_DEFAULTS = {
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
} as const

export const retryConfigSchema = Schema.Struct({
  /** The failure codes worth another attempt; the defaults when the row names none. */
  retryableCodes: Schema.optionalKey(Schema.Array(Schema.Literals(LLM_FAILURE_CODES))),
  /** How many retries one step may make, on top of its first attempt. */
  maxRetries: Schema.optionalKey(Schema.Int),
  /** The wait before the second attempt, doubled for every retry after it. */
  initialDelayMs: Schema.optionalKey(Schema.Number),
  /** The wait a doubling stops at. */
  maxDelayMs: Schema.optionalKey(Schema.Number),
  /** The share of the wait a random swing may add or take away, 0...1. */
  jitterRatio: Schema.optionalKey(Schema.Number),
})

export type RetryConfig = Schema.Schema.Type<typeof retryConfigSchema>

export interface RetryPolicy {
  readonly retryableCodes: ReadonlyArray<LlmFailureCode>
  readonly maxRetries: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** A profile row with every unset field filled in. */
export const resolveRetryPolicy = (config: RetryConfig = {}): RetryPolicy => ({
  retryableCodes: config.retryableCodes ?? DEFAULT_RETRYABLE_CODES,
  maxRetries: config.maxRetries ?? RETRY_DEFAULTS.maxRetries,
  initialDelayMs: config.initialDelayMs ?? RETRY_DEFAULTS.initialDelayMs,
  maxDelayMs: config.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs,
  jitterRatio: config.jitterRatio ?? RETRY_DEFAULTS.jitterRatio,
})

/**
 * The wait before retry `attempt`: exponential from the first retry, capped, with
 * a symmetric jitter so two sessions rejected together do not come back together.
 * `random` is injected so the schedule is testable.
 */
export const retryDelayMs = (
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number => {
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.max(0, attempt - 1))
  const swing = base * policy.jitterRatio * (random() * 2 - 1)
  return Math.max(0, Math.round(base + swing))
}

/**
 * What this policy wants after a failure. Only the listed codes are retried, and
 * only while the attempt count is within the cap; everything else is left to the
 * next listener (or to the loop's failure path).
 */
export const retryDecision = (
  policy: RetryPolicy,
  failure: LlmFailure,
  attempt: number,
  random: () => number = Math.random,
): RequestErrorDecision => {
  if (!policy.retryableCodes.includes(failure.code)) return { kind: 'fail' }
  if (attempt > policy.maxRetries) return { kind: 'fail' }
  return { kind: 'retry', delayMs: retryDelayMs(policy, attempt, random) }
}

/**
 * Registers the transient-failure policy on `agent/request-error`. The listener
 * answers for the codes the agent-loop row lists and hands every other failure to
 * the next listener, so another recovery layer can sit after it.
 */
export const installRetry = (
  hooks: HookRegistry,
  config: RetryConfig = {},
): Effect.Effect<void, never, Scope.Scope> => {
  const policy = resolveRetryPolicy(config)
  return hooks.on('agent/request-error', (_agent, failure, attempt, next) =>
    Effect.suspend(() => {
      const decision = retryDecision(policy, failure, attempt)
      return decision.kind === 'retry' ? Effect.succeed(decision) : next()
    }),
  )
}
