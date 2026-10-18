import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { LlmFailure, type LlmRequest } from '@jozo-harness/llm'
import { Effect, Stream } from 'effect'
import { openAiAdapter } from '../src/index.ts'

const request: LlmRequest = {
  provider: 'ollama-cloud',
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'echo', arguments: '{"text":"a"}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ping' }] },
  ],
  tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }],
  params: {},
}

const adapter = (response: Response) =>
  openAiAdapter({
    baseUrl: 'https://example.test/v1',
    apiKey: () => 'key',
    capabilities: {
      toolChoice: false,
      reasoningEffort: null,
      images: 'none',
      promptCacheControl: false,
    },
    fetch: (() => Promise.resolve(response)) as unknown as typeof fetch,
  })

/** The body a request sent, read back as the JSON text the adapter wrote. */
const bodyOf = (init: RequestInit): string =>
  typeof init.body === 'string' ? init.body : (JSON.stringify(init.body) ?? '')

const collect = (response: Response) => Stream.runCollect(adapter(response).stream(request))

describe('openAiAdapter', () => {
  test('encodes messages, tools, and stream options, then decodes the SSE body', async () => {
    const bodies: Array<string> = []
    const fixture = await readFile(
      new URL('../fixtures/ollama-cloud-tool-call.sse', import.meta.url),
      'utf8',
    )
    const streaming = openAiAdapter({
      baseUrl: 'https://example.test/v1/',
      apiKey: () => 'key',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: ((url: string, init: RequestInit) => {
        bodies.push(String(url))
        bodies.push(bodyOf(init))
        return Promise.resolve(new Response(fixture, { status: 200 }))
      }) as unknown as typeof fetch,
    })

    const chunks = await Effect.runPromise(Stream.runCollect(streaming.stream(request)))
    const sent = JSON.parse(bodies[1] ?? '{}') as Record<string, unknown>

    expect(bodies[0]).toBe('https://example.test/v1/chat/completions')
    expect(sent.stream).toBe(true)
    expect(sent.stream_options).toEqual({ include_usage: true })
    expect((sent.tools as ReadonlyArray<unknown>)[0]).toMatchObject({ type: 'function' })
    expect([...chunks].some((chunk) => chunk.type === 'finish')).toBe(true)
    expect([...chunks].some((chunk) => chunk.type === 'usage')).toBe(true)
  })

  test('the params a request carries reach the body as written', async () => {
    const bodies: Array<string> = []
    const fixture = await readFile(
      new URL('../fixtures/ollama-cloud-tool-call.sse', import.meta.url),
      'utf8',
    )
    const streaming = openAiAdapter({
      baseUrl: 'https://example.test/v1',
      apiKey: () => 'key',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: ((_url: string, init: RequestInit) => {
        bodies.push(bodyOf(init))
        return Promise.resolve(new Response(fixture, { status: 200 }))
      }) as unknown as typeof fetch,
    })

    // The runner writes the field the provider reads; the adapter changes nothing.
    await Effect.runPromise(
      Stream.runCollect(
        streaming.stream({ ...request, params: { reasoning_effort: 'high', max_tokens: 64 } }),
      ),
    )
    const sent = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>

    expect(sent['reasoning_effort']).toBe('high')
    expect(sent['max_tokens']).toBe(64)
    expect(sent).not.toHaveProperty('reasoningEffort')
  })

  test('an HTTP error becomes an AUTH LlmFailure', async () => {
    const error = await Effect.runPromise(
      Effect.flip(collect(new Response('nope', { status: 401 }))),
    )
    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('AUTH')
  })

  test('a context-length rejection becomes a CONTEXT_WINDOW_EXCEEDED LlmFailure', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        collect(
          new Response(
            '{"error":{"message":"This model\'s maximum context length is 131072 tokens. Your request was 140000 tokens."}}',
            { status: 400 },
          ),
        ),
      ),
    )
    expect(error.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  test('a server error becomes a SERVER LlmFailure, and other rejections stay PROVIDER', async () => {
    const server = await Effect.runPromise(
      Effect.flip(collect(new Response('overloaded', { status: 503 }))),
    )
    const refused = await Effect.runPromise(
      Effect.flip(collect(new Response('bad argument', { status: 400 }))),
    )
    expect(server.code).toBe('SERVER')
    expect(refused.code).toBe('PROVIDER')
  })

  test('a rejected fetch becomes a TRANSPORT LlmFailure', async () => {
    const failing = openAiAdapter({
      baseUrl: 'https://example.test/v1',
      apiKey: () => 'key',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })
    const error = await Effect.runPromise(Effect.flip(Stream.runCollect(failing.stream(request))))
    expect(error.code).toBe('TRANSPORT')
  })

  test('a body that cannot be read fails as a transport error', async () => {
    const streaming = openAiAdapter({
      baseUrl: 'https://example.test/v1',
      apiKey: () => 'key',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: (() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.reject(new Error('body gone')),
        })) as unknown as typeof fetch,
    })

    const error = await Effect.runPromise(Effect.flip(Stream.runCollect(streaming.stream(request))))

    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('TRANSPORT')
  })

  test('a failed status reports itself even when its body cannot be read', async () => {
    const streaming = openAiAdapter({
      baseUrl: 'https://example.test/v1',
      apiKey: () => 'key',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: (() =>
        Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.reject(new Error('body gone')),
        })) as unknown as typeof fetch,
    })

    const error = await Effect.runPromise(Effect.flip(Stream.runCollect(streaming.stream(request))))

    expect(error.message).toContain('503')
  })
})
