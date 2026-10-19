import { describe, expect, test } from 'vitest'
import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter } from '@jozo-harness/llm'
import {
  DEFAULT_LOCAL_PROBE_TIMEOUT_MS,
  llmOpenAiPlugin,
  localDaemonReachable,
  makeLlmOpenAiPlugin,
  resolveRoute,
} from '@jozo-harness/llm-openai'
import { Context, Effect, Layer } from 'effect'

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

  test('builds a route from a local daemon that answers, and one from the cloud URL when it does not', async () => {
    const probes: Array<{ baseUrl: string; timeoutMs: number }> = []
    const reachable = makeLlmOpenAiPlugin(async (baseUrl, timeoutMs) => {
      probes.push({ baseUrl, timeoutMs })
      return true
    })
    const absent = makeLlmOpenAiPlugin(async (baseUrl, timeoutMs) => {
      probes.push({ baseUrl, timeoutMs })
      return false
    })
    const local = {
      localBaseUrl: 'http://127.0.0.1:11434/v1',
      localProbeTimeoutMs: 25,
    }

    const onLocal = await adapterWith(local, reachable)
    const onCloud = await adapterWith(local, absent)
    const withoutLocal = await adapterWith({}, absent)

    expect(probes).toEqual([
      { baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 25 },
      { baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 25 },
    ])
    expect(onLocal.name).toBe('openai')
    expect(onCloud.name).toBe('openai')
    expect(withoutLocal.name).toBe('openai')
    // A row that names no local daemon never probes for one.
    expect(probes).toHaveLength(2)
  })
})

describe('local daemon routing', () => {
  test('uses the local daemon only when the row names one and it answered', () => {
    expect(resolveRoute('https://ollama.com/v1', 'http://127.0.0.1:11434/v1', true)).toEqual({
      baseUrl: 'http://127.0.0.1:11434/v1',
      local: true,
    })
    expect(resolveRoute('https://ollama.com/v1', 'http://127.0.0.1:11434/v1', false)).toEqual({
      baseUrl: 'https://ollama.com/v1',
      local: false,
    })
    expect(resolveRoute('https://ollama.com/v1', undefined, true)).toEqual({
      baseUrl: 'https://ollama.com/v1',
      local: false,
    })
  })

  test('probes the models route and treats a rejection or a non-ok answer as absent', async () => {
    const seen: Array<{ url: string; signal: AbortSignal | null | undefined }> = []
    const answering = (status: number) =>
      ((input: string, init?: RequestInit) => {
        seen.push({ url: input, signal: init?.signal })
        return Promise.resolve(new Response(null, { status }))
      }) as unknown as typeof fetch
    const refusing = (() => Promise.reject(new Error('connection refused'))) as typeof fetch

    await expect(
      localDaemonReachable('http://127.0.0.1:11434/v1/', 50, answering(200)),
    ).resolves.toBe(true)
    await expect(
      localDaemonReachable('http://127.0.0.1:11434/v1', 50, answering(500)),
    ).resolves.toBe(false)
    await expect(localDaemonReachable('http://127.0.0.1:11434/v1', 50, refusing)).resolves.toBe(
      false,
    )

    expect(seen[0]?.url).toBe('http://127.0.0.1:11434/v1/models')
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  test('waits the configured budget, and a default one when the row names none', () => {
    expect(DEFAULT_LOCAL_PROBE_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
