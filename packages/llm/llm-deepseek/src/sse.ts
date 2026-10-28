import type { FinishKind, LlmUsage, StreamChunk } from '@jozo-harness/llm'

interface WireUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

interface WireEvent {
  readonly type?: string
  readonly index?: number
  readonly message?: { readonly usage?: WireUsage }
  readonly usage?: WireUsage
  readonly content_block?: {
    readonly type?: string
    readonly id?: string
    readonly name?: string
  }
  readonly delta?: {
    readonly type?: string
    readonly text?: string
    readonly thinking?: string
    readonly partial_json?: string
    readonly stop_reason?: string | null
  }
}

type WireDelta = NonNullable<WireEvent['delta']>

interface DeltaSpec {
  readonly value: (delta: WireDelta) => string | undefined
  readonly make: (index: number, value: string) => StreamChunk
}

/** The payload field and jozo chunk each Messages delta type maps to. */
const DELTAS: Readonly<Record<string, DeltaSpec>> = {
  text_delta: {
    value: (delta) => delta.text,
    make: (index, text) => ({ type: 'text-delta', index, text }),
  },
  thinking_delta: {
    value: (delta) => delta.thinking,
    make: (index, text) => ({ type: 'reasoning-delta', index, text }),
  },
  input_json_delta: {
    value: (delta) => delta.partial_json,
    make: (index, argumentsDelta) => ({ type: 'tool-call-delta', index, id: '', argumentsDelta }),
  },
}

const finishKindOf = (reason: string | null | undefined): FinishKind => {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop'
    case 'tool_use':
      return 'tool-calls'
    case 'max_tokens':
      return 'length'
    default:
      return 'error'
  }
}

/** The Messages API reports usage in two events; the later one wins per field. */
interface Totals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const totalsOf = (): Totals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const absorb = (totals: Totals, usage: WireUsage | undefined): Totals => {
  if (usage === undefined) return totals
  return {
    inputTokens: usage.input_tokens ?? totals.inputTokens,
    outputTokens: usage.output_tokens ?? totals.outputTokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? totals.cacheReadTokens,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? totals.cacheWriteTokens,
  }
}

const usageOf = (totals: Totals): LlmUsage => ({
  inputTokens: totals.inputTokens,
  outputTokens: totals.outputTokens,
  ...(totals.cacheReadTokens === 0 ? {} : { cacheReadTokens: totals.cacheReadTokens }),
  ...(totals.cacheWriteTokens === 0 ? {} : { cacheWriteTokens: totals.cacheWriteTokens }),
})

const payloadOf = (line: string): string | undefined =>
  line.startsWith('data:') ? line.slice('data:'.length).trim() : undefined

/**
 * Decodes the Messages API SSE stream into jozo's chunk vocabulary.
 *
 * Anthropic-shaped endpoints name the event both on the `event:` line and in the
 * JSON body; the body is authoritative, so a proxy that rewrites the former does
 * not change what is read. The stream carries no [DONE]; `message_stop` settles it.
 */
export class MessagesStreamDecoder {
  private totals: Totals = totalsOf()
  private finish: FinishKind | undefined = undefined

  push(line: string): ReadonlyArray<StreamChunk> {
    const payload = payloadOf(line)
    if (payload === undefined) return []
    const event = parseEvent(payload)
    return event === undefined ? [] : this.decode(event)
  }

  private decode(event: WireEvent): ReadonlyArray<StreamChunk> {
    switch (event.type) {
      case 'message_start':
        this.totals = absorb(this.totals, event.message?.usage)
        return []
      case 'content_block_start':
        return this.takeBlockStart(event)
      case 'content_block_delta':
        return this.takeDelta(event)
      case 'message_delta':
        return this.takeMessageDelta(event)
      case 'message_stop':
        return this.takeStop()
      default:
        return []
    }
  }

  private takeBlockStart(event: WireEvent): ReadonlyArray<StreamChunk> {
    const index = event.index ?? 0
    const block = event.content_block
    switch (block?.type) {
      case 'tool_use':
        return [
          { type: 'block-start', index, blockType: 'tool-call' },
          {
            type: 'tool-call-delta',
            index,
            id: block.id ?? '',
            name: block.name ?? '',
            argumentsDelta: '',
          },
        ]
      case 'thinking':
      case 'redacted_thinking':
        return [{ type: 'block-start', index, blockType: 'reasoning' }]
      case 'text':
        return [{ type: 'block-start', index, blockType: 'text' }]
      default:
        return []
    }
  }

  private takeDelta(event: WireEvent): ReadonlyArray<StreamChunk> {
    const delta = event.delta
    const spec = delta?.type === undefined ? undefined : DELTAS[delta.type]
    if (spec === undefined || delta === undefined) return []
    const value = spec.value(delta)
    return value === undefined ? [] : [spec.make(event.index ?? 0, value)]
  }

  private takeMessageDelta(event: WireEvent): ReadonlyArray<StreamChunk> {
    this.totals = absorb(this.totals, event.usage)
    this.finish = finishKindOf(event.delta?.stop_reason)
    return [{ type: 'usage', usage: usageOf(this.totals) }]
  }

  private takeStop(): ReadonlyArray<StreamChunk> {
    if (this.finish === undefined) this.finish = 'stop'
    const chunk: StreamChunk = { type: 'finish', kind: this.finish }
    this.finish = undefined
    return [chunk]
  }
}

const parseEvent = (payload: string): WireEvent | undefined => {
  try {
    return JSON.parse(payload) as WireEvent
  } catch {
    return undefined
  }
}

/** Decodes a complete recorded stream. The adapter uses the decoder incrementally. */
export function decodeMessagesStream(lines: ReadonlyArray<string>): ReadonlyArray<StreamChunk> {
  const decoder = new MessagesStreamDecoder()
  return lines.flatMap((line) => decoder.push(line))
}
