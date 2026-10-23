import type { ContentBlock, FinishKind, LlmUsage, StreamChunk } from './types.ts'

type Draft =
  | { readonly kind: 'text' | 'reasoning'; readonly text: string }
  | {
      readonly kind: 'tool-call'
      readonly id: string
      readonly name: string | undefined
      readonly arguments: string
    }

/** The settled content, usage, and finish of one assistant response. */
export interface AssembledMessage {
  readonly content: ReadonlyArray<ContentBlock>
  readonly usage: LlmUsage | undefined
  readonly finish: FinishKind | undefined
}

const toBlock = (draft: Draft, index: number): ContentBlock => {
  switch (draft.kind) {
    case 'text':
      return { type: 'text', text: draft.text }
    case 'reasoning':
      return { type: 'reasoning', text: draft.text }
    case 'tool-call':
      if (draft.name === undefined) {
        throw new Error(`tool call at block ${index} settled without a name`)
      }
      return { type: 'tool-call', id: draft.id, name: draft.name, arguments: draft.arguments }
  }
}

/**
 * Folds one adapter stream into the content recorded on `assistant/message`.
 * A settled `block-end` block wins over the deltas accumulated for its index.
 */
export class BlockAssembler {
  private readonly drafts = new Map<number, Draft>()
  private readonly settled = new Map<number, ContentBlock>()
  private usageValue: LlmUsage | undefined
  private finishValue: FinishKind | undefined

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start':
        this.drafts.set(chunk.index, startDraft(chunk.blockType))
        return
      case 'text-delta':
        this.appendText(chunk.index, 'text', chunk.text)
        return
      case 'reasoning-delta':
        this.appendText(chunk.index, 'reasoning', chunk.text)
        return
      case 'tool-call-delta':
        this.appendToolCall(chunk)
        return
      case 'block-end':
        this.settled.set(chunk.index, chunk.block)
        return
      case 'usage':
        this.usageValue = chunk.usage
        return
      case 'finish':
        this.finishValue = chunk.kind
        return
    }
    const exhaustive: never = chunk
    throw new Error(`unreachable stream chunk: ${JSON.stringify(exhaustive)}`)
  }

  /** The response so far. Call after `finish` for the complete message. */
  snapshot(): AssembledMessage {
    const indexes = [...new Set([...this.drafts.keys(), ...this.settled.keys()])].sort(
      (left, right) => left - right,
    )
    return {
      content: indexes.map((index) => {
        const settled = this.settled.get(index)
        if (settled !== undefined) return settled
        const draft = this.drafts.get(index)
        if (draft === undefined)
          throw new Error(`block ${index} has neither a draft nor a settled block`)
        return toBlock(draft, index)
      }),
      usage: this.usageValue,
      finish: this.finishValue,
    }
  }

  private appendText(index: number, kind: 'text' | 'reasoning', text: string): void {
    const draft = this.drafts.get(index)
    if (draft !== undefined && draft.kind === kind) {
      this.drafts.set(index, { kind, text: draft.text + text })
      return
    }
    this.drafts.set(index, { kind, text })
  }

  private appendToolCall(chunk: Extract<StreamChunk, { type: 'tool-call-delta' }>): void {
    const draft = this.drafts.get(chunk.index)
    const base: Extract<Draft, { kind: 'tool-call' }> =
      draft !== undefined && draft.kind === 'tool-call'
        ? draft
        : { kind: 'tool-call', id: chunk.id, name: undefined, arguments: '' }
    this.drafts.set(chunk.index, {
      kind: 'tool-call',
      // A continuation fragment often carries no id. An empty one must not
      // replace the id the call opened with, or the result cannot be paired.
      id: chunk.id !== '' ? chunk.id : base.id,
      name: chunk.name ?? base.name,
      arguments: base.arguments + chunk.argumentsDelta,
    })
  }
}

const startDraft = (blockType: ContentBlock['type']): Draft => {
  switch (blockType) {
    case 'text':
    case 'reasoning':
      return { kind: blockType, text: '' }
    case 'tool-call':
      return { kind: 'tool-call', id: '', name: undefined, arguments: '' }
    case 'image':
      throw new Error('image blocks arrive whole; they cannot be streamed')
  }
}
