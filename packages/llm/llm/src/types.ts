import { Data } from 'effect'
import type { Stream } from 'effect'

/** One block of model-facing content. Tool call arguments stay a raw JSON string. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | {
      readonly type: 'image'
      /** The media type, e.g. image/png. */
      readonly mediaType: string
      /** Base64 of the image bytes. */
      readonly data: string
      readonly name?: string
    }
  | {
      readonly type: 'tool-call'
      readonly id: string
      readonly name: string
      readonly arguments: string
    }

export type ContentBlockType = ContentBlock['type']

/** Token accounting reported by the provider for one request. */
export interface LlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens?: number
}

/** How a model response ended. `error` carries no content of its own. */
export type FinishKind = 'stop' | 'tool-calls' | 'length' | 'error'

/** The closed stream vocabulary an adapter emits. */
export type StreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: ContentBlockType }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
      readonly type: 'tool-call-delta'
      readonly index: number
      readonly id: string
      readonly name?: string
      readonly argumentsDelta: string
    }
  | { readonly type: 'block-end'; readonly index: number; readonly block: ContentBlock }
  | { readonly type: 'usage'; readonly usage: LlmUsage }
  | { readonly type: 'finish'; readonly kind: FinishKind }

/** Provider-neutral failure classes. Consumers branch on `code`, never on wording. */
export const LLM_FAILURE_CODES = [
  'AUTH',
  'RATE_LIMIT',
  'TIMEOUT',
  'ABORTED',
  'EMPTY_RESPONSE',
  'CONTEXT_WINDOW_EXCEEDED',
  'TRANSPORT',
  'PROVIDER',
  'INVALID_REQUEST',
] as const

export type LlmFailureCode = (typeof LLM_FAILURE_CODES)[number]

export class LlmFailure extends Data.TaggedError('LlmFailure')<{
  readonly code: LlmFailureCode
  readonly message: string
}> {}

/** What an adapter can do. Consumers must not assume one provider's features. */
export interface LlmCapabilities {
  readonly toolChoice: boolean
  /**
   * The reasoning-effort levels this adapter knows the endpoint takes. `null` means
   * the adapter declares none: whatever the deployment resolves is passed through
   * as `reasoning_effort` and the endpoint decides whether it takes it.
   */
  readonly reasoningEffort: ReadonlyArray<string> | null
  readonly images: 'base64' | 'none'
  readonly promptCacheControl: boolean
  /**
   * The routed model's context window in tokens, when the adapter knows it. The
   * agent loop measures request pressure against it; absent leaves the loop's
   * configured default.
   */
  readonly contextWindow?: number
  /**
   * What one image block costs the routed model, when the adapter knows it. The
   * meter prices an image as a reference of this size rather than by the base64
   * the log carries; absent leaves the meter's own reference.
   */
  readonly imageTokens?: number
}

/** A tool declaration as it reaches the provider. */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** One provider-bound message. A tool message names the call it answers. */
export interface RequestMessage {
  readonly role: MessageRole
  readonly content: ReadonlyArray<ContentBlock>
  readonly toolCallId?: string
}

/** One provider attempt. The adapter neither retries nor reassembles it. */
export interface LlmRequest {
  readonly provider: string
  readonly model: string
  readonly messages: ReadonlyArray<RequestMessage>
  readonly tools: ReadonlyArray<ToolSchema> | undefined
  readonly params: Readonly<Record<string, unknown>>
}

/** One provider adapter. One `stream` call is one attempt; it never retries internally. */
export interface LlmAdapter {
  readonly name: string
  readonly capabilities: LlmCapabilities
  stream(request: LlmRequest): Stream.Stream<StreamChunk, LlmFailure>
}
