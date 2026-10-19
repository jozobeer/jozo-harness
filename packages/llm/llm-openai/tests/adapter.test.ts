import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { LlmFailure, type LlmRequest, type StreamChunk } from '@jozo-harness/llm'
import { Effect, Fiber, Stream } from 'effect'
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

const encoder = new TextEncoder()

/** One SSE event, encoded the way an OpenAI-compatible provider writes it. */
const sseLine = (payload: string): Uint8Array => encoder.encode(`data: ${payload}\n\n`)

/** An adapter whose fetch is the test's own, with the capabilities every case shares. */
const adapterWith = (fetchImpl: typeof fetch, streamIdleTimeoutMs?: number) =>
  openAiAdapter({
    baseUrl: 'https://example.test/v1',
    apiKey: () => 'key',
    capabilities: {
      toolChoice: false,
      reasoningEffort: null,
      images: 'none',
      promptCacheControl: false,
    },
    ...(streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs }),
    fetch: fetchImpl,
  })

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

  test('an anonymous local route sends no Authorization header when no key is set', async () => {
    const fixture = await readFile(
      new URL('../fixtures/ollama-cloud-tool-call.sse', import.meta.url),
      'utf8',
    )
    const headers: Array<Headers> = []
    const streaming = openAiAdapter({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: () => undefined,
      allowAnonymous: true,
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: ((_url: string, init: RequestInit) => {
        headers.push(new Headers(init.headers))
        return Promise.resolve(new Response(fixture, { status: 200 }))
      }) as unknown as typeof fetch,
    })

    const chunks = await Effect.runPromise(Stream.runCollect(streaming.stream(request)))

    expect(headers[0]?.has('Authorization')).toBe(false)
    expect(headers[0]?.get('Content-Type')).toBe('application/json')
    expect([...chunks].some((chunk) => chunk.type === 'finish')).toBe(true)
  })

  test('sends the row headers as written and keeps its own auth and content type', async () => {
    const headers: Array<Headers> = []
    const streaming = openAiAdapter({
      baseUrl: 'https://opencode.ai/inference/openai/v1',
      apiKey: () => 'key',
      // OpenCode asks for a client user agent and a routing session; the row
      // supplies both. A header it names itself stays the adapter's.
      headers: { 'User-Agent': 'jzh/1.0', 'x-opencode-session': 's-1', authorization: 'stale' },
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: ((_url: string, init: RequestInit) => {
        headers.push(new Headers(init.headers))
        return Promise.resolve(new Response('data: [DONE]\n\n', { status: 200 }))
      }) as unknown as typeof fetch,
    })

    await Effect.runPromise(Stream.runCollect(streaming.stream(request)))

    expect(headers[0]?.get('user-agent')).toBe('jzh/1.0')
    expect(headers[0]?.get('x-opencode-session')).toBe('s-1')
    expect(headers[0]?.get('authorization')).toBe('Bearer key')
    expect(headers[0]?.get('content-type')).toBe('application/json')
  })

  test('a route that does not allow anonymous calls still fails without a key', async () => {
    const streaming = openAiAdapter({
      baseUrl: 'https://example.test/v1',
      apiKey: () => undefined,
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: (() => Promise.reject(new Error('must not be called'))) as unknown as typeof fetch,
    })

    const error = await Effect.runPromise(Effect.flip(Stream.runCollect(streaming.stream(request))))

    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('AUTH')
  })

  test('an HTTP error becomes an AUTH LlmFailure', async () => {
    const error = await Effect.runPromise(
      Effect.flip(collect(new Response('nope', { status: 401 }))),
    )
    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('AUTH')
  })

  test('a Console free-tier rejection is AUTH and keeps the provider reason', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        collect(
          new Response(
            '{"error":{"message":"Free models are only available from OpenCode itself","type":"FreeTierError"}}',
            { status: 403 },
          ),
        ),
      ),
    )

    // A 403 is an auth-class failure whatever the provider calls it, and the
    // body is what tells a person the free tier is the reason.
    expect(error.code).toBe('AUTH')
    expect(error.message).toContain('FreeTierError')
    expect(error.message).toContain('only available from OpenCode itself')
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

  test('refuses an image block when the route declares it carries none', async () => {
    let fetched = 0
    const streaming = openAiAdapter({
      baseUrl: 'https://example.test/v1',
      apiKey: () => 'key',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      fetch: (() => {
        fetched += 1
        return Promise.resolve(new Response(''))
      }) as unknown as typeof fetch,
    })
    const withImage: LlmRequest = {
      ...request,
      messages: [
        {
          role: 'tool',
          toolCallId: 'c1',
          content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
        },
      ],
    }

    const error = await Effect.runPromise(
      Effect.flip(Stream.runCollect(streaming.stream(withImage))),
    )

    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('INVALID_REQUEST')
    expect(error.message).toContain('cannot carry images')
    expect(fetched).toBe(0)
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
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error('body gone'))
              },
            }),
            { status: 200 },
          ),
        )) as unknown as typeof fetch,
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

  test('delivers a text delta before the provider finishes the response', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const seen: Array<StreamChunk> = []
    let announceText: () => void = () => {}
    const textArrived = new Promise<void>((resolve) => {
      announceText = resolve
    })
    const enqueue = (payload: string) => controller?.enqueue(sseLine(payload))
    const respond = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch

    const arrivedEarly = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const consuming = yield* Stream.runForEach(
            adapterWith(respond).stream(request),
            (chunk) =>
              Effect.sync(() => {
                seen.push(chunk)
                if (chunk.type === 'text-delta') announceText()
              }),
          ).pipe(Effect.forkScoped)

          enqueue('{"choices":[{"delta":{"content":"hel"}}]}')
          const early = yield* Effect.promise(() =>
            Promise.race([
              textArrived.then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
            ]),
          )
          enqueue('{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}')
          enqueue('[DONE]')
          controller?.close()
          yield* Fiber.join(consuming)
          return early
        }),
      ),
    )

    expect(arrivedEarly).toBe(true)
    expect(seen.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : []))).toEqual([
      'hel',
      'lo',
    ])
    expect(seen.at(-1)).toEqual({ type: 'finish', kind: 'stop' })
  })

  test('keeps a response alive while chunks keep arriving past the idle budget', async () => {
    const send = ((_url: string, init: RequestInit) => {
      let step = 0
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const timer = setInterval(() => {
                if (step < 8) {
                  controller.enqueue(
                    sseLine('{"choices":[{"delta":{"content":"x"},"finish_reason":null}]}'),
                  )
                } else if (step === 8) {
                  controller.enqueue(sseLine('{"choices":[{"delta":{},"finish_reason":"stop"}]}'))
                } else {
                  clearInterval(timer)
                  controller.close()
                }
                step += 1
              }, 40)
              init.signal?.addEventListener(
                'abort',
                () => {
                  clearInterval(timer)
                  controller.error(init.signal?.reason ?? new Error('aborted'))
                },
                { once: true },
              )
            },
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const chunks = await Effect.runPromise(
      Stream.runCollect(adapterWith(send, 200).stream(request)),
    )

    // The provider takes longer than the idle budget overall; only the gaps matter.
    expect([...chunks].at(-1)).toEqual({ type: 'finish', kind: 'stop' })
    expect(chunks.length).toBeGreaterThan(8)
  })

  test('a body that stops sending bytes fails as a TIMEOUT', async () => {
    const stalled = ((_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener(
                'abort',
                () => controller.error(init.signal?.reason ?? new Error('aborted')),
                { once: true },
              )
            },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const error = await Effect.runPromise(
      Effect.flip(Stream.runCollect(adapterWith(stalled, 40).stream(request))),
    )

    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('TIMEOUT')
  })

  test('a request that never answers fails as a TIMEOUT', async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true },
        )
      })) as unknown as typeof fetch

    const error = await Effect.runPromise(
      Effect.flip(Stream.runCollect(adapterWith(hanging, 40).stream(request))),
    )

    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('TIMEOUT')
  })

  test('a response without a body fails as a TRANSPORT error', async () => {
    const bodyless = (() =>
      Promise.resolve({ ok: true, status: 200, body: null })) as unknown as typeof fetch

    const error = await Effect.runPromise(
      Effect.flip(Stream.runCollect(adapterWith(bodyless).stream(request))),
    )

    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('TRANSPORT')
  })

  test('a body that ends without [DONE] still flushes a held finish', async () => {
    const body = new Response(
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      { status: 200 },
    )

    const chunks = await Effect.runPromise(collect(body))

    expect([...chunks].at(-1)).toEqual({ type: 'finish', kind: 'stop' })
  })
})
