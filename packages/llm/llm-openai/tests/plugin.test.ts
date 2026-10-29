import { describe, expect, test } from 'vitest'
import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type LlmRequest, type LlmTransport } from '@jozo-harness/llm'
import {
  llmOpenAiPlugin,
  localOllamaModelName,
  makeLlmOpenAiPlugin,
} from '@jozo-harness/llm-openai'
import { Context, Effect, Layer, Stream } from 'effect'

describe('llmOpenAiPlugin', () => {
  /** The adapter one profile row builds, so a test can name only what it varies. */
  const adapterWith = async (
    config: Readonly<Record<string, unknown>>,
    plugin = llmOpenAiPlugin,
  ): Promise<LlmAdapter> =>
    await Effect.runPromise(
      Effect.gen(function* () {
        const layer = yield* loadProfile({
          plugins: [kernelPlugin, plugin],
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

  const request: LlmRequest = {
    provider: 'ollama-cloud',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: undefined,
    params: {},
  }

  /** A fetch that records each request and answers a chat with an empty stream. */
  const capture = () => {
    const bodies: Array<string> = []
    const urls: Array<string> = []
    const headers: Array<Headers> = []
    const send = ((url: string, init?: RequestInit) => {
      urls.push(String(url))
      if (!String(url).endsWith('/chat/completions')) return Promise.resolve(new Response('{}'))
      bodies.push(typeof init?.body === 'string' ? init.body : '')
      headers.push(new Headers(init?.headers))
      return Promise.resolve(new Response('data: [DONE]\n\n', { status: 200 }))
    }) as unknown as LlmTransport
    return { bodies, headers, urls, send }
  }

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

  test('the headers a row names reach the provider', async () => {
    const { headers, send } = capture()
    const keyEnv = 'JZH_LLM_OPENCODE_TEST_KEY'
    process.env[keyEnv] = 'test-key'
    try {
      // A Console row names the client and a routing session; the adapter
      // adds its bearer token on top.
      const onConsole = await adapterWith(
        {
          baseUrl: 'https://opencode.ai/inference/openai/v1',
          apiKeyEnv: keyEnv,
          localBaseUrl: '',
          headers: { 'User-Agent': 'jzh/1.0', 'x-opencode-session': 's-1' },
        },
        makeLlmOpenAiPlugin(send),
      )

      await Effect.runPromise(Stream.runCollect(onConsole.stream(request)))
    } finally {
      delete process.env[keyEnv]
    }

    expect(headers[0]?.get('user-agent')).toBe('jzh/1.0')
    expect(headers[0]?.get('x-opencode-session')).toBe('s-1')
    expect(headers[0]?.get('authorization')).toBe('Bearer test-key')
  })

  test('a row with a local daemon sends there without probing, under the name the daemon knows', async () => {
    const { bodies, urls, send } = capture()
    const onLocal = await adapterWith(
      { localBaseUrl: 'http://127.0.0.1:11434/v1' },
      makeLlmOpenAiPlugin(send),
    )

    await Effect.runPromise(Stream.runCollect(onLocal.stream(request)))

    expect(urls).toEqual(['http://127.0.0.1:11434/v1/chat/completions'])
    expect((JSON.parse(bodies[0] ?? '{}') as { model?: string }).model).toBe(
      'deepseek-v4.1-flash:cloud',
    )
  })

  test('a row that turns the local route off sends to baseUrl under the route name', async () => {
    const { bodies, urls, send } = capture()
    const keyEnv = 'JZH_LLM_OPENAI_TEST_KEY'
    process.env[keyEnv] = 'test-key'
    try {
      // The bundled profile names a local daemon; an empty value opts out.
      const onCloud = await adapterWith(
        { apiKeyEnv: keyEnv, localBaseUrl: '' },
        makeLlmOpenAiPlugin(send),
      )

      await Effect.runPromise(Stream.runCollect(onCloud.stream(request)))
    } finally {
      delete process.env[keyEnv]
    }

    expect(urls).toEqual(['https://ollama.com/v1/chat/completions'])
    expect((JSON.parse(bodies[0] ?? '{}') as { model?: string }).model).toBe('deepseek-v4.1-flash')
  })
})

describe('local daemon model names', () => {
  test('names a cloud model the way a local Ollama daemon knows it', () => {
    expect(localOllamaModelName('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash:cloud')
    expect(localOllamaModelName('deepseek-v4-pro:0813')).toBe('deepseek-v4-pro:0813-cloud')
    // A name that already names the cloud model stays as it is.
    expect(localOllamaModelName('deepseek-v4.1-flash:cloud')).toBe('deepseek-v4.1-flash:cloud')
    expect(localOllamaModelName('deepseek-v4-pro:0813-cloud')).toBe('deepseek-v4-pro:0813-cloud')
  })
})
