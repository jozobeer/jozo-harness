import { describe, expect, test } from 'vitest'
import type { LlmCapabilities } from '@jozo-harness/llm'
import { thresholdOf } from '@jozo-harness/session'
import { modelOfRoute, tokenBudgetOf } from '../src/index.ts'

const capabilities = (overrides: Partial<LlmCapabilities> = {}): LlmCapabilities => ({
  toolChoice: false,
  reasoningEffort: null,
  images: 'none',
  promptCacheControl: false,
  ...overrides,
})

describe('modelOfRoute', () => {
  test('names the model with the whole suffix a registry key uses', () => {
    expect(modelOfRoute('ollama/deepseek-v4.1-flash:cloud')).toBe('deepseek-v4.1-flash:cloud')
    expect(modelOfRoute('model-only')).toBe('')
  })
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

  test('reads the window and output reservation of the routed model from the row', () => {
    const budget = tokenBudgetOf(
      {
        // The single values are the fallback for routes the registry does not name.
        contextWindow: 64_000,
        maxTokens: 1_000,
        models: {
          'deepseek-v4.1-flash:cloud': { contextWindow: 1_048_576, maxTokens: 393_216 },
        },
      },
      capabilities({ contextWindow: 32_000 }),
      'deepseek-v4.1-flash:cloud',
    )

    expect(budget.contextWindow).toBe(1_048_576)
    expect(budget.reserveTokens).toBe(393_216)
    // The output reservation comes off the window before the headroom, so the
    // line sits at the 589,824 dsh uses for the same model.
    expect(thresholdOf(budget)).toBe(589_824)
  })

  test('does not reserve the routed model output limit on a model it does not name', () => {
    const budget = tokenBudgetOf(
      { models: { known: { contextWindow: 1_048_576, maxTokens: 393_216 } } },
      capabilities({ contextWindow: 32_000 }),
      'other',
    )

    expect(budget.contextWindow).toBe(32_000)
    expect(budget.reserveTokens).toBe(0)
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
      'deepseek-v4.1-flash:cloud',
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
