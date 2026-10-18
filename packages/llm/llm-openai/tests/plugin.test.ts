import { describe, expect, test } from 'vitest'
import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter } from '@jozo-harness/llm'
import { llmOpenAiPlugin } from '@jozo-harness/llm-openai'
import { Context, Effect, Layer } from 'effect'

describe('llmOpenAiPlugin', () => {
  /** The adapter one profile row builds, so a test can name only what it varies. */
  const adapterWith = async (config: Readonly<Record<string, unknown>>): Promise<LlmAdapter> =>
    await Effect.runPromise(
      Effect.gen(function* () {
        const layer = yield* loadProfile({
          plugins: [kernelPlugin, llmOpenAiPlugin],
          layers: [
            [
              { id: 'kernel', name: '@jozo-harness/kernel', config: {} },
              {
                id: 'llm',
                name: '@jozo-harness/llm-openai',
                config: {
                  baseUrl: 'https://ollama.com/v1',
                  apiKeyEnv: 'OLLAMA_API_KEY',
                  ...config,
                },
              },
            ],
          ],
        })
        const context = yield* Layer.build(layer)
        return Context.get(context, Llm)
      }).pipe(Effect.scoped),
    )

  test('builds an adapter from its profile config', async () => {
    const adapter = await adapterWith({ streamIdleTimeoutMs: 1000 })

    expect(adapter.name).toBe('openai')
    expect(adapter.capabilities.toolChoice).toBe(false)
  })

  test('the effort words come from the row, and default to the ones the wire takes', async () => {
    const declared = await adapterWith({ reasoningEfforts: ['low', 'max'] })
    const fallback = await adapterWith({})

    // A row that names the words its endpoint takes decides what a UI offers.
    expect(declared.capabilities.reasoningEffort).toEqual(['low', 'max'])
    // The whole escalation the field is known to take, unless the row narrows it.
    expect(fallback.capabilities.reasoningEffort).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('rejects a config that is missing baseUrl', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        loadProfile({
          plugins: [kernelPlugin, llmOpenAiPlugin],
          layers: [[{ id: 'llm', name: '@jozo-harness/llm-openai', config: { apiKeyEnv: 'K' } }]],
        }),
      ),
    )

    expect(error.code).toBe('config')
  })
})
