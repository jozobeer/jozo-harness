import type { ContentBlock, RequestMessage } from '@jozo-harness/llm'
import { deriveMessagesWithSeqs } from './derive.ts'
import type { SessionEvent } from './events.ts'
import { lastRequestHeader } from './request-header.ts'

/** What one token is estimated to carry when only bytes are known. */
export const BYTES_PER_TOKEN = 4

/** The routed model's context window, and how close to it a request may come. */
export interface TokenBudget {
  /** The model's context window, in tokens. */
  readonly contextWindow: number
  /** Compact when the estimate reaches this fraction of the window. */
  readonly thresholdRatio: number
  /** Always leave this many tokens between the threshold and the window. */
  readonly headroomTokens: number
  /**
   * Output tokens one request reserves. The provider charges them to the same window,
   * so they are gone before the headroom is. Unset reserves nothing.
   */
  readonly reserveTokens?: number
  /**
   * What one image block costs the routed model. Provider visual pricing does not
   * scale with the base64 the log carries, so an image is a reference of this size;
   * the adapter declares it when it knows the route. Unset prices one image as
   * {@link IMAGE_REFERENCE_TOKENS}.
   */
  readonly imageTokens?: number
}

/** What is left of the window for messages once the answer's room is reserved. */
export const messageBudgetOf = (budget: TokenBudget): number =>
  Math.max(0, budget.contextWindow - (budget.reserveTokens ?? 0))

/**
 * The pressure line: the tighter of the window fraction and the room left after the
 * answer's reservation and the headroom.
 */
export const thresholdOf = (budget: TokenBudget): number =>
  Math.max(
    1,
    Math.min(
      Math.floor(budget.contextWindow * budget.thresholdRatio),
      messageBudgetOf(budget) - budget.headroomTokens,
    ),
  )

/** Where the estimate came from: what the provider last counted, or bytes alone. */
export type TokenMeterSource = 'usage' | 'bytes'

export interface TokenMeter {
  /** The tokens the next request is estimated to carry. */
  readonly estimated: number
  /** Where compaction fires. */
  readonly threshold: number
  /** Tokens still free before the threshold; negative means the request is past it. */
  readonly remaining: number
  /** Whether the estimate reached the threshold: the condition compaction fires on. */
  readonly compacts: boolean
  readonly source: TokenMeterSource
}

const ENCODER = new TextEncoder()

const bytesOf = (text: string): number => ENCODER.encode(text).length

/**
 * What one image block costs when the routed model declares nothing. An image's
 * tokens are the provider's to price and do not scale with the base64 the log
 * carries: a fixed reference keeps one screenshot from reading as a whole window,
 * while staying above the structural price of the reference alone.
 */
export const IMAGE_REFERENCE_TOKENS = 1_000

const blockBytes = (block: ContentBlock, imageTokens: number): number => {
  if (block.type === 'text' || block.type === 'reasoning') return bytesOf(block.text)
  if (block.type === 'image') return imageTokens * BYTES_PER_TOKEN
  return bytesOf(block.name + block.arguments)
}

/** What one message adds to a request, as the request carries it after the fold. */
const messageBytes = (message: RequestMessage, imageTokens: number): number =>
  message.content.reduce((sum, block) => sum + blockBytes(block, imageTokens), 0)

/**
 * What one message is estimated to carry. The meter's own rule, so a whole request
 * and the tail a compaction retains are counted the same way.
 */
export const messageTokens = (
  message: RequestMessage,
  imageTokens: number = IMAGE_REFERENCE_TOKENS,
): number => Math.ceil(messageBytes(message, imageTokens) / BYTES_PER_TOKEN)

/** The bytes the fold would send for a log, with every recorded compaction applied. */
const foldedBytes = (events: ReadonlyArray<SessionEvent>, imageTokens: number): number =>
  deriveMessagesWithSeqs(events).reduce(
    (sum, entry) => sum + messageBytes(entry.message, imageTokens),
    0,
  )

/**
 * The bytes the tool schemas cost, as the newest recorded request carried them. Every
 * request from that series on sends them, so they are pressure like the messages are.
 */
const toolsBytes = (events: ReadonlyArray<SessionEvent>): number => {
  const header = lastRequestHeader(events)
  return header === undefined ? 0 : bytesOf(JSON.stringify(header.tools))
}

/** What one request carries: its messages and the tools it may call. */
const surfaceBytes = (events: ReadonlyArray<SessionEvent>, imageTokens: number): number =>
  toolsBytes(events) + foldedBytes(events, imageTokens)

/**
 * The newest provider count in the log, as the tokens that one request carried.
 * Everything up to and including its answer is already inside the number.
 */
const newestUsage = (
  events: ReadonlyArray<SessionEvent>,
): { readonly index: number; readonly tokens: number } | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message' || event.data.usage === undefined) continue
    const usage = event.data.usage
    return { index, tokens: usage.inputTokens + usage.outputTokens }
  }
  return undefined
}

/**
 * The pressure of the next request, read from the log alone: the newest provider
 * usage when there is one, plus an estimate of everything the fold gained or lost
 * since. What the fold carries is what gets sent, so a recorded compaction lowers
 * the estimate at the step it is recorded rather than one provider round trip later.
 * A resumed session measures the same way as a live one.
 */
export const meterOf = (events: ReadonlyArray<SessionEvent>, budget: TokenBudget): TokenMeter => {
  const anchor = newestUsage(events)
  const imageTokens = budget.imageTokens ?? IMAGE_REFERENCE_TOKENS
  const counted =
    anchor === undefined ? 0 : surfaceBytes(events.slice(0, anchor.index + 1), imageTokens)
  const estimated = Math.max(
    0,
    (anchor?.tokens ?? 0) +
      Math.ceil((surfaceBytes(events, imageTokens) - counted) / BYTES_PER_TOKEN),
  )
  const threshold = thresholdOf(budget)
  return {
    estimated,
    threshold,
    remaining: threshold - estimated,
    compacts: estimated >= threshold,
    source: anchor === undefined ? 'bytes' : 'usage',
  }
}
