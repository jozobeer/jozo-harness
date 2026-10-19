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

/** Whether any message carries an image block the encoder cannot render. */
const carriesImage = (messages: ReadonlyArray<RequestMessage>): boolean =>
  messages.some((message) => message.content.some((block) => block.type === 'image'))

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

/** Aborts one attempt when the body produces no bytes within the idle budget. */
interface IdleGuard {
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
  arm(): void
  disarm(): void
}

/**
 * The idle budget restarts on every read. A total-time bound would cut a long
 * reasoning stream that is still producing tokens, while no bound at all would
 * let a stalled provider hold the turn open forever.
 */
const idleGuardOf = (timeoutMs: number): IdleGuard => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const arm = (): void => {
    disarm()
    timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, timeoutMs)
  }
  return { signal: controller.signal, timedOut: () => expired, arm, disarm }
}

const readFailureOf = (cause: unknown, guard: IdleGuard): LlmFailure =>
  guard.timedOut()
    ? new LlmFailure({
        code: 'TIMEOUT',
        message: 'provider stream went idle; no bytes arrived within the idle budget',
      })
    : new LlmFailure({ code: 'TRANSPORT', message: `cannot read the response: ${String(cause)}` })

/**
 * OpenAI-compatible adapter. One `stream` call is one provider attempt: it never
 * retries internally, so a failed attempt stays visible to the agent loop.
 *
 * The body is decoded as it arrives, so a step's text reaches the loop before the
 * provider finishes, and the idle timer restarts on every chunk.
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
          // The adapter encodes text only, so an image that reaches it would
          // vanish. Refuse loudly instead of sending an empty result.
          if (options.capabilities.images === 'none' && carriesImage(request.messages)) {
            return yield* Effect.fail(
              new LlmFailure({
                code: 'INVALID_REQUEST',
                message:
                  'the current route cannot carry images, but the request contains one; answer without it or switch to an image-capable route',
              }),
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
          const guard = idleGuardOf(timeout)
          guard.arm()
          const response = yield* Effect.tryPromise({
            try: () =>
              send(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body,
                signal: guard.signal,
              }),
            catch: (cause) => {
              const failure = guard.timedOut()
                ? new LlmFailure({
                    code: 'TIMEOUT',
                    message: `provider did not answer within ${timeout} ms`,
                  })
                : new LlmFailure({
                    code: 'TRANSPORT',
                    message: `provider request failed: ${String(cause)}`,
                  })
              guard.disarm()
              return failure
            },
          })
          if (!response.ok) {
            const detail = yield* Effect.match(
              Effect.tryPromise({
                try: () => response.text(),
                catch: (cause) => new LlmFailure({ code: 'TRANSPORT', message: String(cause) }),
              }),
              { onFailure: () => '', onSuccess: (value) => value },
            )
            guard.disarm()
            return yield* Effect.fail(failureForStatus(response.status, detail))
          }
          const responseBody = response.body
          if (responseBody === null) {
            guard.disarm()
            return yield* Effect.fail(
              new LlmFailure({ code: 'TRANSPORT', message: 'the response carried no body' }),
            )
          }
          guard.arm()
          const decoder = new OpenAiStreamDecoder()
          return Stream.fromReadableStream({
            evaluate: () => responseBody,
            onError: (cause) => readFailureOf(cause, guard),
          }).pipe(
            // Each network read resets the budget: a heartbeat keeps a long
            // reasoning response alive without a total-time cap.
            Stream.tap(() => Effect.sync(() => guard.arm())),
            Stream.decodeText(),
            Stream.splitLines,
            // A provider may close without [DONE]; the decoder still holds a
            // finish until usage arrives, so flush it just as a [DONE] would.
            Stream.concat(Stream.make('data: [DONE]')),
            Stream.flatMap((line) => Stream.fromIterable(decoder.push(line))),
            Stream.ensuring(Effect.sync(() => guard.disarm())),
          )
        }),
      ),
  }
}
