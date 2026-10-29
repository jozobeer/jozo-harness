import { describe, expect, test } from 'vitest'
import { LlmFailure, type LlmRequest, type LlmTransport, type StreamChunk } from '@jozo-harness/llm'
import { Effect, Stream } from 'effect'
import { decodeMessagesStream, deepSeekMessagesAdapter } from '../src/index.ts'

const request: LlmRequest = {
  provider: 'deepseek',
  model: 'deepseek-reasoner',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'not sent back' },
        { type: 'text', text: 'using a tool' },
        { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{"text":"a"}' },
      ],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ping' }] },
    { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'pong' }] },
  ],
  tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }],
  params: {},
}

const capabilities = {
  toolChoice: false,
  reasoningEffort: null,
  images: 'none',
  promptCacheControl: false,
} as const

const adapterWith = (
  fetchImpl: LlmTransport,
  options: {
    readonly maxTokens?: number
    readonly extensions?: Readonly<Record<string, unknown>>
  } = {},
) =>
  deepSeekMessagesAdapter({
    baseUrl: 'https://api.deepseek.com/anthropic/v1',
    apiKey: () => 'key',
    capabilities,
    transport: fetchImpl,
    ...options,
  })

const bodyOf = (init: RequestInit): string => (typeof init.body === 'string' ? init.body : '')

const capture = (body = '') => {
  const seen: Array<{ readonly url: string; readonly headers: Headers; readonly body: string }> = []
  const send = ((url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers), body: bodyOf(init) })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as unknown as LlmTransport
  return { seen, send }
}

const sse = (events: ReadonlyArray<readonly [string, unknown]>): string =>
  events.map(([name, body]) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`).join('')

const collect = (send: LlmTransport, source: LlmRequest = request) =>
  Effect.runPromise(Stream.runCollect(adapterWith(send).stream(source)))

describe('deepSeekMessagesAdapter', () => {
  test('sends the official Messages body, not the OpenAI-compatible one', async () => {
    const { seen, send } = capture('')

    await collect(send, {
      ...request,
      params: { temperature: 0.2, reasoning_effort: 'high', thinking: { type: 'enabled' } },
    })

    const sent = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>
    expect(seen[0]?.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(seen[0]?.headers.get('x-api-key')).toBe('key')
    expect(seen[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(sent.model).toBe('deepseek-reasoner')
    expect(sent.stream).toBe(true)
    expect(sent.max_tokens).toBe(8192)
    expect(sent.system).toBe('be brief')
    expect(sent.temperature).toBe(0.2)
    expect(sent).not.toHaveProperty('stream_options')

    const messages = sent.messages as ReadonlyArray<{
      readonly role: string
      readonly content: ReadonlyArray<Record<string, unknown>>
    }>
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    // Two tool results answer one assistant turn, so they share one user turn.
    expect(messages[2]?.content).toHaveLength(2)
    const assistant = messages[1]?.content ?? []
    expect(assistant[1]).toEqual({
      type: 'tool_use',
      id: 'c1',
      name: 'echo',
      input: { text: 'a' },
    })
    expect((sent.tools as ReadonlyArray<Record<string, unknown>>)[0]).toMatchObject({
      name: 'echo',
      input_schema: { type: 'object' },
    })
    expect(sent).not.toHaveProperty('thinking')
    expect(sent).not.toHaveProperty('reasoning_effort')
  })

  test('a base URL without the API version still lands on /v1/messages', async () => {
    const { seen, send } = capture('')
    const streaming = deepSeekMessagesAdapter({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: () => 'key',
      capabilities,
      transport: send,
    })

    await Effect.runPromise(Stream.runCollect(streaming.stream(request)))

    expect(seen[0]?.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
  })

  test('a row bound applies unless the request names its own', async () => {
    const first = capture('')
    const second = capture('')

    await Effect.runPromise(
      Stream.runCollect(adapterWith(first.send, { maxTokens: 1024 }).stream(request)),
    )
    await Effect.runPromise(
      Stream.runCollect(
        adapterWith(second.send).stream({ ...request, params: { max_tokens: 64 } }),
      ),
    )

    expect((JSON.parse(first.seen[0]?.body ?? '{}') as { max_tokens?: number }).max_tokens).toBe(
      1024,
    )
    expect((JSON.parse(second.seen[0]?.body ?? '{}') as { max_tokens?: number }).max_tokens).toBe(
      64,
    )
  })

  test('maps Messages events to reasoning, text, usage, and finish chunks', async () => {
    const body = sse([
      [
        'message_start',
        {
          type: 'message_start',
          message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
        },
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
        },
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } },
      ],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])

    const chunks = await collect(capture(body).send)

    expect([...chunks]).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'hmm' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'hi' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3 } },
      { type: 'finish', kind: 'stop' },
    ])
  })

  test('turns streamed tool input into tool-call deltas and a tool-calls finish', async () => {
    const body = sse([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 2 } } }],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'c1', name: 'echo' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"text":' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"a"}' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])

    const chunks = await collect(capture(body).send)
    const deltas = [...chunks].filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> =>
        chunk.type === 'tool-call-delta',
    )

    expect(deltas.map((delta) => delta.argumentsDelta)).toEqual(['', '{"text":', '"a"}'])
    expect(deltas[0]).toMatchObject({ index: 0, id: 'c1', name: 'echo' })
    expect([...chunks].at(-1)).toEqual({ type: 'finish', kind: 'tool-calls' })
  })

  test('sends no extension field when the row names none', async () => {
    const plain = capture('')

    await collect(plain.send)

    const sent = JSON.parse(plain.seen[0]?.body ?? '{}') as Record<string, unknown>
    expect(sent).not.toHaveProperty('thinking')
    expect(sent).not.toHaveProperty('reasoning')
  })

  test('sends the extension fields the official row opts into', async () => {
    const extended = capture('')

    await Effect.runPromise(
      Stream.runCollect(
        adapterWith(extended.send, {
          extensions: { thinking: { type: 'enabled' }, reasoning: 'high' },
        }).stream(request),
      ),
    )

    const sent = JSON.parse(extended.seen[0]?.body ?? '{}') as Record<string, unknown>
    expect(sent['thinking']).toEqual({ type: 'enabled' })
    expect(sent['reasoning']).toBe('high')
  })

  test('refuses an image block before the official endpoint sees it', async () => {
    let fetched = 0
    const send = (() => {
      fetched += 1
      return Promise.resolve(new Response(''))
    }) as unknown as LlmTransport

    const error = await Effect.runPromise(
      Effect.flip(
        Stream.runCollect(
          adapterWith(send).stream({
            ...request,
            messages: [
              {
                role: 'user',
                content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
              },
            ],
          }),
        ),
      ),
    )

    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('INVALID_REQUEST')
    expect(fetched).toBe(0)
  })

  test('ignores malformed and unknown events, then settles the stream', () => {
    const chunks = decodeMessagesStream([
      'event: ping',
      'data: {"type":"ping"}',
      'data: not json',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"audio"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta"}}',
      'data: {"type":"message_stop"}',
    ])

    expect(chunks).toEqual([{ type: 'finish', kind: 'stop' }])
  })

  test('an HTTP rejection keeps the provider detail and its class', async () => {
    const send = (() =>
      Promise.resolve(new Response('bad key', { status: 401 }))) as unknown as LlmTransport

    const error = await Effect.runPromise(
      Effect.flip(Stream.runCollect(adapterWith(send).stream(request))),
    )

    expect(error).toBeInstanceOf(LlmFailure)
    expect(error.code).toBe('AUTH')
    expect(error.message).toContain('bad key')
  })
})
