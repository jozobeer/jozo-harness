import { type FinishKind, type LlmUsage, type StreamChunk } from '@jozo-harness/llm'

interface OpenAiToolCallDelta {
  readonly index?: number
  readonly id?: string
  readonly function?: { readonly name?: string; readonly arguments?: string }
}

interface OpenAiDelta {
  readonly content?: string | null
  readonly reasoning?: string | null
  /** DeepSeek-style endpoints put the thinking under this name instead. */
  readonly reasoning_content?: string | null
  readonly tool_calls?: ReadonlyArray<OpenAiToolCallDelta>
}

interface OpenAiUsage {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number }
  readonly prompt_tokens_details?: { readonly cached_tokens?: number }
}

interface OpenAiChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: OpenAiDelta
    readonly finish_reason?: string | null
  }>
  readonly usage?: OpenAiUsage | null
}

const REASONING_INDEX = 0
const TEXT_INDEX = 1
const TOOL_INDEX_BASE = 2

const finishKindOf = (reason: string | null | undefined): FinishKind => {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'tool_calls':
      return 'tool-calls'
    case 'length':
      return 'length'
    default:
      return 'error'
  }
}

const toUsage = (usage: OpenAiUsage | null | undefined): LlmUsage | undefined => {
  if (usage === undefined || usage === null) return undefined
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
  // The wire counts prompt_tokens with the cache included; jozo's buckets are
  // disjoint, so the cached share moves out of the non-cache input.
  const cached = usage.prompt_tokens_details?.cached_tokens
  const promptTokens = usage.prompt_tokens ?? 0
  return {
    inputTokens: Math.max(0, promptTokens - (cached ?? 0)),
    outputTokens: usage.completion_tokens ?? 0,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
  }
}

type BlockKind = 'reasoning' | 'text'

interface BlockSpec {
  readonly index: number
  readonly make: (text: string) => StreamChunk
}

/** How one open text block maps to its index and delta chunk. */
const BLOCKS: Readonly<Record<BlockKind, BlockSpec>> = {
  reasoning: {
    index: REASONING_INDEX,
    make: (text) => ({ type: 'reasoning-delta', index: REASONING_INDEX, text }),
  },
  text: {
    index: TEXT_INDEX,
    make: (text) => ({ type: 'text-delta', index: TEXT_INDEX, text }),
  },
}

const payloadOf = (line: string): string | undefined =>
  line.startsWith('data:') ? line.slice('data:'.length).trim() : undefined

const parseChunk = (payload: string): OpenAiChunk | undefined => {
  try {
    return JSON.parse(payload) as OpenAiChunk
  } catch {
    return undefined
  }
}

const hasText = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value !== ''

/**
 * The thinking text one delta carries. OpenAI and Ollama name it `reasoning`
 * while DeepSeek-compatible endpoints (DeepSeek, GLM, Kimi) name it
 * `reasoning_content`; a chunk that carries both is read once.
 */
const reasoningOf = (delta: OpenAiDelta): string | undefined => {
  for (const value of [delta.reasoning, delta.reasoning_content]) {
    if (hasText(value)) return value
  }
  return undefined
}

/**
 * Decodes the OpenAI-compatible SSE stream into the jozo-harness chunk vocabulary.
 *
 * OpenRouter-style providers put `usage` in a chunk with `choices: []` that
 * arrives *after* `finish_reason`, so this decoder holds the finish chunk back
 * and emits it after usage. Tool calls may arrive complete and several at a
 * time, so each entry becomes its own `tool-call-delta`.
 */
export class OpenAiStreamDecoder {
  private openBlock: 'reasoning' | 'text' | undefined = undefined
  private pendingFinish: FinishKind | undefined = undefined

  push(line: string): ReadonlyArray<StreamChunk> {
    const payload = payloadOf(line)
    if (payload === undefined) return []
    if (payload === '[DONE]') return this.flushFinish()
    const parsed = parseChunk(payload)
    return parsed === undefined ? [] : this.decode(parsed)
  }

  private decode(parsed: OpenAiChunk): ReadonlyArray<StreamChunk> {
    const chunks: Array<StreamChunk> = []
    const usage = toUsage(parsed.usage)
    if (usage !== undefined) chunks.push(...this.takeUsage(usage))
    const choice = parsed.choices?.[0]
    if (choice?.delta !== undefined) chunks.push(...this.takeDelta(choice.delta))
    const reason = choice?.finish_reason
    if (reason !== undefined && reason !== null) {
      chunks.push(...this.takeFinish(reason, usage !== undefined))
    }
    return chunks
  }

  /** Usage wins the order: a held finish follows it, not the other way around. */
  private takeUsage(usage: LlmUsage): Array<StreamChunk> {
    const chunks: Array<StreamChunk> = [{ type: 'usage', usage }]
    if (this.pendingFinish !== undefined) {
      chunks.push({ type: 'finish', kind: this.pendingFinish })
      this.pendingFinish = undefined
    }
    return chunks
  }

  private takeDelta(delta: OpenAiDelta): Array<StreamChunk> {
    const chunks: Array<StreamChunk> = []
    const reasoning = reasoningOf(delta)
    if (reasoning !== undefined) chunks.push(...this.emitDelta('reasoning', reasoning))
    if (hasText(delta.content)) chunks.push(...this.emitDelta('text', delta.content))
    for (const call of delta.tool_calls ?? []) chunks.push(...this.takeToolCall(call))
    return chunks
  }

  private emitDelta(kind: BlockKind, text: string): Array<StreamChunk> {
    const chunks: Array<StreamChunk> = []
    if (this.openBlock !== kind) {
      this.openBlock = kind
      chunks.push({ type: 'block-start', index: BLOCKS[kind].index, blockType: kind })
    }
    chunks.push(BLOCKS[kind].make(text))
    return chunks
  }

  private takeToolCall(call: OpenAiToolCallDelta): Array<StreamChunk> {
    this.openBlock = undefined
    const name = call.function?.name
    return [
      {
        type: 'tool-call-delta',
        index: TOOL_INDEX_BASE + (call.index ?? 0),
        id: call.id ?? '',
        ...(name === undefined ? {} : { name }),
        argumentsDelta: call.function?.arguments ?? '',
      },
    ]
  }

  private takeFinish(reason: string, usageSettled: boolean): Array<StreamChunk> {
    const kind = finishKindOf(reason)
    if (usageSettled) return [{ type: 'finish', kind }]
    this.pendingFinish = kind
    return []
  }

  private flushFinish(): Array<StreamChunk> {
    const finish = this.pendingFinish
    this.pendingFinish = undefined
    return finish === undefined ? [] : [{ type: 'finish', kind: finish }]
  }
}

/** Decodes a complete recorded stream. The adapter uses the decoder incrementally. */
export function decodeOpenAiStream(lines: ReadonlyArray<string>): ReadonlyArray<StreamChunk> {
  const decoder = new OpenAiStreamDecoder()
  const chunks: Array<StreamChunk> = []
  for (const line of lines) chunks.push(...decoder.push(line))
  chunks.push(...decoder.push('data: [DONE]'))
  return chunks
}
