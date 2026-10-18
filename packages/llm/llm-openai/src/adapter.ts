import {
  LlmFailure,
  type ContentBlock,
  type LlmAdapter,
  type LlmCapabilities,
  type LlmFailureCode,
  type LlmRequest,
  type RequestMessage,
  type StreamChunk,
} from '@jozo-harness/llm'
import { Effect, Stream } from 'effect'
import { OpenAiStreamDecoder } from './sse.ts'

export interface OpenAiAdapterOptions {
  readonly baseUrl: string
  readonly apiKey: () => string | undefined
  readonly capabilities: LlmCapabilities
  /** Idle budget for one attempt. Defaults to five minutes. */
  readonly streamIdleTimeoutMs?: number
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000

const textOf = (content: ReadonlyArray<ContentBlock>): string =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

const encodeMessage = (message: RequestMessage): Record<string, unknown> => {
  const toolCalls = message.content.flatMap((block) =>
    block.type === 'tool-call'
      ? [
          {
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: block.arguments },
          },
        ]
      : [],
  )
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? '',
      content: textOf(message.content),
    }
  }
  if (message.role === 'assistant' && toolCalls.length > 0) {
    return { role: 'assistant', content: textOf(message.content), tool_calls: toolCalls }
  }
  return { role: message.role, content: textOf(message.content) }
}

/**
 * The wording OpenAI-compatible providers use when the input itself is too long.
 * The status alone cannot tell this from any other rejected request, so the body
 * is the only signal; an endpoint that words it differently stays PROVIDER.
 */
const CONTEXT_OVERFLOW =
  /context[ _-]?(?:length|window)|too many tokens|input is too long|prompt is too long|reduce the length/i

const codeForStatus = (status: number): LlmFailureCode => {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER'
}

/** A rejected request says whether the input itself was too long. */
const rejectedAsTooLong = (status: number, detail: string): boolean =>
  (status === 400 || status === 413) && CONTEXT_OVERFLOW.test(detail)

const failureForStatus = (status: number, detail: string): LlmFailure => {
  const code = rejectedAsTooLong(status, detail) ? 'CONTEXT_WINDOW_EXCEEDED' : codeForStatus(status)
  return new LlmFailure({
    code,
    message: `provider returned HTTP ${status}: ${detail.slice(0, 200)}`,
  })
}

/**
 * OpenAI-compatible adapter. One `stream` call is one provider attempt: it never
 * retries internally, so a failed attempt stays visible to the agent loop.
 *
 * The recorded Ollama Cloud stream is buffered before decoding; incremental
 * delivery is a follow-up once the HTTP client seam is Effect-native.
 */
export function openAiAdapter(options: OpenAiAdapterOptions): LlmAdapter {
  const send = options.fetch ?? fetch
  const timeout = options.streamIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const url = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`

  return {
    name: 'openai',
    capabilities: options.capabilities,

    stream: (request: LlmRequest): Stream.Stream<StreamChunk, LlmFailure> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const apiKey = options.apiKey()
          if (apiKey === undefined || apiKey === '') {
            return yield* Effect.fail(
              new LlmFailure({ code: 'AUTH', message: 'no API key is configured' }),
            )
          }
          const body = JSON.stringify({
            model: request.model,
            messages: request.messages.map(encodeMessage),
            ...(request.tools === undefined
              ? {}
              : { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) }),
            stream: true,
            stream_options: { include_usage: true },
            ...request.params,
          })
          const response = yield* Effect.tryPromise({
            try: () =>
              send(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(timeout),
              }),
            catch: (cause) =>
              new LlmFailure({
                code:
                  cause instanceof Error && cause.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT',
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
            return yield* Effect.fail(failureForStatus(response.status, detail))
          }
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (cause) =>
              new LlmFailure({
                code: 'TRANSPORT',
                message: `cannot read the response: ${String(cause)}`,
              }),
          })
          const decoder = new OpenAiStreamDecoder()
          const chunks: Array<StreamChunk> = []
          for (const line of text.split('\n')) chunks.push(...decoder.push(line))
          chunks.push(...decoder.push('data: [DONE]'))
          return Stream.fromIterable(chunks)
        }),
      ),
  }
}
