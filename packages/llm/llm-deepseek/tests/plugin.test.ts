import { describe, expect, test } from 'vitest'
import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type LlmRequest } from '@jozo-harness/llm'
import { llmDeepSeekPlugin, makeLlmDeepSeekPlugin } from '@jozo-harness/llm-deepseek'
import { Context, Effect, Layer, Stream } from 'effect'

describe('llmDeepSeekPlugin', () => {
  const adapterWith = async (
    config: Readonly<Record<string, unknown>>,
    send: typeof fetch = fetch,
  ): Promise<LlmAdapter> =>
    await Effect.runPromise(
      Effect.gen(function* () {
        const layer = yield* loadProfile({
          plugins: [kernelPlugin, makeLlmDeepSeekPlugin(send)],
          layers: [
            [
              { id: 'kernel', name: '@jozo-harness/kernel', config: {} },
              {
                id: 'llm',
                name: '@jozo-harness/llm-deepseek',
                config: {
                  baseUrl: 'https://api.deepseek.com/anthropic/v1',
                  apiKeyEnv: 'DEEPSEEK_API_KEY',
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

  const request: LlmRequest = {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: undefined,
    params: {},
  }

  test('builds the official adapter from a profile row', async () => {
    const adapter = await adapterWith({ maxTokens: 2048 })

    expect(adapter.name).toBe('deepseek')
    expect(adapter.capabilities.toolChoice).toBe(false)
    expect(adapter.capabilities.images).toBe('none')
  })

  test('rejects a row that names no base URL', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        loadProfile({
          plugins: [kernelPlugin, llmDeepSeekPlugin],
          layers: [[{ id: 'llm', name: '@jozo-harness/llm-deepseek', config: { apiKeyEnv: 'K' } }]],
        }),
      ),
    )

    expect(error.code).toBe('config')
  })

  test('the row key and extensions reach the request', async () => {
    const keyEnv = 'JZH_LLM_DEEPSEEK_TEST_KEY'
    process.env[keyEnv] = 'test-key'
    const bodies: Array<string> = []
    const headers: Array<Headers> = []
    const send = ((_url: string, init: RequestInit) => {
      bodies.push(typeof init.body === 'string' ? init.body : '')
      headers.push(new Headers(init.headers))
      return Promise.resolve(new Response('', { status: 200 }))
    }) as unknown as typeof fetch
    try {
      const adapter = await adapterWith(
        { apiKeyEnv: keyEnv, extensions: { thinking: { type: 'enabled' } } },
        send,
      )

      await Effect.runPromise(Stream.runCollect(adapter.stream(request)))
    } finally {
      delete process.env[keyEnv]
    }

    expect(headers[0]?.get('x-api-key')).toBe('test-key')
    expect((JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>)['thinking']).toEqual({
      type: 'enabled',
    })
  })
})
