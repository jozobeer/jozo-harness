import { describe, expect, test } from 'vitest'
import type { LlmCapabilities } from '@jozo-harness/llm'
import { tokenBudgetOf } from '../src/index.ts'

const capabilities = (overrides: Partial<LlmCapabilities> = {}): LlmCapabilities => ({
  toolChoice: false,
  reasoningEffort: null,
  images: 'none',
  promptCacheControl: false,
  ...overrides,
})

describe('tokenBudgetOf', () => {
  test('takes the window and image price from the adapter when the profile is silent', () => {
    const budget = tokenBudgetOf({}, capabilities({ contextWindow: 32_000, imageTokens: 50 }))

    expect(budget).toEqual({
      contextWindow: 32_000,
      thresholdRatio: 0.8,
      headroomTokens: 65_536,
      reserveTokens: 0,
      imageTokens: 50,
    })
  })

  test('the loop row overrides every value the adapter could name', () => {
    const budget = tokenBudgetOf(
      {
        contextWindow: 1_000,
        thresholdRatio: 0.9,
        headroomTokens: 100,
        maxTokens: 200,
      },
      capabilities({ contextWindow: 32_000, imageTokens: 50 }),
    )

    expect(budget).toEqual({
      contextWindow: 1_000,
      thresholdRatio: 0.9,
      headroomTokens: 100,
      reserveTokens: 200,
      imageTokens: 50,
    })
  })
})
