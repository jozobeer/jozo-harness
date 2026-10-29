import {
  LlmFailure,
  fetchTransport,
  type ContentBlock,
  type LlmAdapter,
  type LlmCapabilities,
  type LlmFailureCode,
  type LlmRequest,
  type LlmTransport,
  type RequestMessage,
  type StreamChunk,
  type ToolSchema,
} from '@jozo-harness/llm'
import { Effect, Stream } from 'effect'
import { MessagesStreamDecoder } from './sse.ts'

export interface DeepSeekMessagesOptions {
  readonly baseUrl: string
  readonly apiKey: () => string | undefined
  /** The Messages API requires a bound; the row may lower it per route. */
  readonly maxTokens?: number
  /**
   * Top-level fields the official endpoint takes beyond the Messages API, such
   * as `thinking`. A row that names none sends none; nothing is inferred.
   */
  readonly extensions?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly capabilities: LlmCapabilities
  /** The one way this adapter reaches the provider. Defaults to the page's fetch. */
  readonly transport?: LlmTransport
}

const DEFAULT_MAX_TOKENS = 8192
const ANTHROPIC_VERSION = '2023-06-01'

/** The Messages sampling fields a route may pass through; nothing else is a body field. */
const SAMPLING = new Set([
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
  'service_tier',
])

const textOf = (content: ReadonlyArray<ContentBlock>): string =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

const isKeyed = (apiKey: string | undefined): apiKey is string =>
  apiKey !== undefined && apiKey !== ''

const carriesImage = (messages: ReadonlyArray<RequestMessage>): boolean =>
  messages.some((message) => message.content.some((block) => block.type === 'image'))

/** Tool arguments stay a JSON string on jozo's side; Messages wants an object. */
const inputOf = (argumentsText: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const blocksOf = (message: RequestMessage): ReadonlyArray<Record<string, unknown>> => {
  if (message.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: textOf(message.content),
      },
    ]
  }
  return message.content.flatMap((block): ReadonlyArray<Record<string, unknown>> => {
    switch (block.type) {
      case 'text':
        return [{ type: 'text', text: block.text }]
      case 'tool-call':
        return [
          {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: inputOf(block.arguments),
          },
        ]
      // Reasoning blocks carry no signature to send back, and images are
      // refused before encoding; neither can become a Messages block.
      case 'reasoning':
      case 'image':
        return []
    }
  })
}

interface WireMessage {
  readonly role: 'user' | 'assistant'
  readonly content: Array<Record<string, unknown>>
}

/** Consecutive tool results join one user turn; parallel calls produce that shape. */
const appendTurn = (wire: Array<WireMessage>, message: RequestMessage): void => {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const content = [...blocksOf(message)]
  const previous = wire.at(-1)
  if (previous === undefined || previous.role !== role) {
    wire.push({ role, content })
    return
  }
  previous.content.push(...content)
}

const conversationOf = (messages: ReadonlyArray<RequestMessage>): ReadonlyArray<WireMessage> => {
  const wire: Array<WireMessage> = []
  for (const message of messages) {
    if (message.role !== 'system') appendTurn(wire, message)
  }
  return wire
}

const toolOf = (tool: ToolSchema): Record<string, unknown> => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
})

const paramsOf = (params: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).filter(([key]) => SAMPLING.has(key)))

/** A bound is required; a request's own number wins over the row's default. */
const maxTokensOf = (request: LlmRequest, configured: number | undefined): number => {
  const asked = request.params['max_tokens']
  if (typeof asked === 'number' && asked > 0) return asked
  return configured ?? DEFAULT_MAX_TOKENS
}

const codeFor = (status: number): LlmFailureCode => {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER'
}

const rejection = (status: number, detail: string): LlmFailure => {
  const tooLong =
    (status === 400 || status === 413) &&
    /context[ _-]?(?:length|window)|too many tokens|input is too long/i.test(detail)
  return new LlmFailure({
    code: tooLong ? 'CONTEXT_WINDOW_EXCEEDED' : codeFor(status),
    message: `provider returned HTTP ${status}: ${detail.slice(0, 200)}`,
  })
}

/**
 * The official root names the provider but not the API version, while a gateway
 * may already end at `/v1`. Both documented forms must reach `/v1/messages`.
 */
const messagesUrlOf = (baseUrl: string): string => {
  const base = baseUrl.replace(/\/+$/, '')
  return (base.endsWith('/v1') ? base : base + '/v1') + '/messages'
}

/**
 * The official DeepSeek Messages endpoint. One `stream` call is one provider
 * attempt, and the body carries only Messages fields: the OpenAI-compatible
 * adapter keeps the `/chat/completions` shape for endpoints that speak it.
 */
export function deepSeekMessagesAdapter(options: DeepSeekMessagesOptions): LlmAdapter {
  const send = options.transport ?? fetchTransport
  const url = messagesUrlOf(options.baseUrl)
  const extensions = options.extensions ?? {}

  return {
    name: 'deepseek',
    capabilities: options.capabilities,

    stream: (request: LlmRequest): Stream.Stream<StreamChunk, LlmFailure> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const apiKey = options.apiKey()
          if (!isKeyed(apiKey)) {
            return yield* Effect.fail(
              new LlmFailure({ code: 'AUTH', message: 'no API key is configured' }),
            )
          }
          if (options.capabilities.images === 'none' && carriesImage(request.messages)) {
            return yield* Effect.fail(
              new LlmFailure({
                code: 'INVALID_REQUEST',
                message: 'the official messages route cannot carry images',
              }),
            )
          }
          const system = request.messages
            .filter((message) => message.role === 'system')
            .map((message) => textOf(message.content))
            .join('\n\n')
          const body = JSON.stringify({
            model: request.model,
            max_tokens: maxTokensOf(request, options.maxTokens),
            messages: conversationOf(request.messages),
            stream: true,
            ...(system === '' ? {} : { system }),
            ...(request.tools === undefined ? {} : { tools: request.tools.map(toolOf) }),
            ...paramsOf(request.params),
            ...extensions,
          })
          const response = yield* Effect.tryPromise({
            try: () =>
              send(url, {
                method: 'POST',
                headers: headersOf(apiKey, options.headers),
                body,
              }),
            catch: (cause) =>
              new LlmFailure({
                code: 'TRANSPORT',
                message: `provider request failed: ${String(cause)}`,
              }),
          })
          if (!response.ok) {
            const detail = yield* Effect.match(
              Effect.tryPromise({
                try: () => response.text(),
                catch: (cause) => new LlmFailure({ code: 'TRANSPORT', message: String(cause) }),
              }),
              { onFailure: () => '', onSuccess: (value) => value },
            )
            return yield* Effect.fail(rejection(response.status, detail))
          }
          const responseBody = response.body
          if (responseBody === null) {
            return yield* Effect.fail(
              new LlmFailure({ code: 'TRANSPORT', message: 'the response carried no body' }),
            )
          }
          const decoder = new MessagesStreamDecoder()
          return Stream.fromReadableStream({
            evaluate: () => responseBody,
            onError: (cause) =>
              new LlmFailure({
                code: 'TRANSPORT',
                message: `cannot read the response: ${String(cause)}`,
              }),
          }).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.flatMap((line) => Stream.fromIterable(decoder.push(line))),
          )
        }),
      ),
  }
}

const headersOf = (
  apiKey: string,
  extra: Readonly<Record<string, string>> | undefined,
): Headers => {
  const headers = new Headers(extra)
  headers.set('x-api-key', apiKey)
  headers.set('anthropic-version', ANTHROPIC_VERSION)
  headers.set('Content-Type', 'application/json')
  return headers
}
