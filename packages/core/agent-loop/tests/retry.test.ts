import { describe, expect, test } from 'vitest'
import { LlmFailure } from '@jozo-harness/llm'
import {
  DEFAULT_RETRYABLE_CODES,
  resolveRetryPolicy,
  retryDecision,
  retryDelayMs,
} from '../src/index.ts'

const failure = (code: 'RATE_LIMIT' | 'AUTH' | 'CONTEXT_WINDOW_EXCEEDED') =>
  new LlmFailure({ code, message: code })

describe('retry policy', () => {
  test('the defaults retry the transient codes and stop at the cap', () => {
    const policy = resolveRetryPolicy()
    expect(policy.retryableCodes).toEqual(DEFAULT_RETRYABLE_CODES)
    expect(retryDecision(policy, failure('RATE_LIMIT'), 1)).toEqual({
      kind: 'retry',
      delayMs: expect.any(Number),
    })
    expect(retryDecision(policy, failure('RATE_LIMIT'), policy.maxRetries)).toMatchObject({
      kind: 'retry',
    })
    expect(retryDecision(policy, failure('RATE_LIMIT'), policy.maxRetries + 1)).toEqual({
      kind: 'fail',
    })
  })

  test('a code the row does not list is not retried', () => {
    const policy = resolveRetryPolicy({ retryableCodes: ['TIMEOUT'] })
    expect(retryDecision(policy, failure('AUTH'), 1)).toEqual({ kind: 'fail' })
    expect(retryDecision(policy, failure('CONTEXT_WINDOW_EXCEEDED'), 1)).toEqual({ kind: 'fail' })
  })

  test('the wait doubles, stops at the cap, and jitters inside the ratio', () => {
    const policy = resolveRetryPolicy({ initialDelayMs: 100, maxDelayMs: 250, jitterRatio: 0 })
    expect(retryDelayMs(policy, 1)).toBe(100)
    expect(retryDelayMs(policy, 2)).toBe(200)
    expect(retryDelayMs(policy, 3)).toBe(250)
    const jittered = resolveRetryPolicy({ initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.5 })
    expect(retryDelayMs(jittered, 1, () => 0)).toBe(50)
    expect(retryDelayMs(jittered, 1, () => 1)).toBe(150)
  })
})
