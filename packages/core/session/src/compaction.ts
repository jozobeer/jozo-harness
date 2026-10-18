import type { ContentBlock, RequestMessage } from '@jozo-harness/llm'
import { deriveMessagesWithSeqs, prunedSeqs, type DerivedMessage } from './derive.ts'
import type {
  CompactReplacement,
  CompactionCheckpoint,
  CompactionPrune,
  SessionEvent,
  SessionSeq,
} from './events.ts'
import { registerMessageProjection, type MessageProjection } from './projections.ts'
import { lastRuntimeContextSeq } from './runtime-context.ts'
import { latestSystemSeq } from './system-message.ts'
import { messageTokens } from './token-meter.ts'

export interface CompactOptions {
  /** The newest messages are never touched: together they fit in this many estimated tokens. */
  readonly retainTokens: number
  /** Text blocks larger than this many bytes are replaced by a shorter form. */
  readonly maxBytes: number
}

/** What a profile gets when its agent-loop row names no prune price. */
export const DEFAULT_COMPACT_MAX_BYTES = 32_000

const bytesOf = (text: string): number => new TextEncoder().encode(text).length

const stub = (text: string): ContentBlock => ({
  type: 'text',
  text: '[earlier output of ' + String(bytesOf(text)) + ' bytes] ' + text.slice(0, 120),
})

/** The marker a tool result keeps in place of a span the pruner removed. */
export const TOOL_RESULT_PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
/** A tool result past this many characters keeps only its ends. */
export const TOOL_RESULT_PRUNE_CHARS = 8192
/** How much of a pruned tool result's head stays. */
export const TOOL_RESULT_KEEP_HEAD_CHARS = 4096
/** How much of a pruned tool result's tail stays. */
export const TOOL_RESULT_KEEP_TAIL_CHARS = 1024

/**
 * A tool result past the price keeps its head and tail, with a marker between
 * them. Sliced by code point, so a retained boundary cannot split a surrogate
 * pair. Reading the tool again is the way back to the middle.
 */
const middlePruned = (text: string): string => {
  const points = Array.from(text)
  if (points.length <= TOOL_RESULT_PRUNE_CHARS) return text
  return (
    points.slice(0, TOOL_RESULT_KEEP_HEAD_CHARS).join('') +
    TOOL_RESULT_PRUNE_MARKER +
    points.slice(points.length - TOOL_RESULT_KEEP_TAIL_CHARS).join('')
  )
}

/** An image the request stops carrying, with what it says instead. */
const imageReference = (block: Extract<ContentBlock, { type: 'image' }>): ContentBlock => ({
  type: 'text',
  text:
    '[image offloaded: ' +
    (block.name ?? block.mediaType) +
    '; read it again with the read_image tool to see it]',
})

interface PrunedBlocks {
  readonly content: ReadonlyArray<ContentBlock>
  /** Whether the request carries something other than this content. */
  readonly changed: boolean
  /** What the request no longer carries, in bytes. */
  readonly replacedBytes: number
}

/** How many bytes the request stops carrying for one block that changed. */
const freedBytesOf = (block: ContentBlock): number => {
  if (block.type === 'image') return block.data.length
  return block.type === 'text' ? bytesOf(block.text) : 0
}

/**
 * One block as the request keeps it: reasoning is dropped, an image becomes a
 * reference, a tool result past its own price keeps only its ends, and any other
 * oversized text is stubbed. The same block comes back when it is left alone.
 */
const pruneBlock = (
  block: ContentBlock,
  options: { readonly maxBytes: number; readonly toolResult: boolean },
): ContentBlock | undefined => {
  if (block.type === 'reasoning') return undefined
  if (block.type === 'image') return imageReference(block)
  if (block.type !== 'text') return block
  if (options.toolResult) {
    const cut = middlePruned(block.text)
    if (cut !== block.text) return { type: 'text', text: cut }
  }
  return bytesOf(block.text) > options.maxBytes ? stub(block.text) : block
}

/** What one old message stops carrying; the newest messages never reach here. */
const pruneBlocks = (
  content: ReadonlyArray<ContentBlock>,
  options: { readonly maxBytes: number; readonly toolResult: boolean },
): PrunedBlocks => {
  const kept: Array<ContentBlock> = []
  let changed = false
  let replacedBytes = 0
  for (const block of content) {
    const pruned = pruneBlock(block, options)
    if (pruned !== block) {
      changed = true
      replacedBytes += freedBytesOf(block)
    }
    if (pruned !== undefined) kept.push(pruned)
  }
  return { content: kept, changed, replacedBytes }
}

/** Replaces the content of the events the prune names, wherever they landed. */
const applyReplacements = (
  derived: ReadonlyArray<DerivedMessage>,
  replacements: ReadonlyArray<CompactReplacement>,
): ReadonlyArray<DerivedMessage> => {
  const bySeq = new Map(replacements.map((replacement) => [replacement.seq, replacement.content]))
  return derived.map((entry) => {
    const content = bySeq.get(entry.seq)
    return content === undefined
      ? entry
      : { seq: entry.seq, message: { ...entry.message, content } }
  })
}

/** The line a checkpoint message opens with: the model reads it as background. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the ' +
  'conversation. Treat it as established background and continue from the messages ' +
  'that follow, without acknowledging it.\n\n'

/**
 * The projection the session actually uses: a recorded prune rewrites the content
 * of the events it shadows, so the request and the log stay the same thing.
 */
export const pruneProjection: MessageProjection = {
  type: 'compaction/prune',
  name: 'compaction/prune',
  project: (event, derived) =>
    event.type === 'compaction/prune'
      ? applyReplacements(derived, event.data.replacements)
      : derived,
}

registerMessageProjection(pruneProjection)

/**
 * Where the untouched tail starts: the newest messages whose estimated tokens together
 * fit in the target. The newest is kept whatever its size, so a request never ends up
 * with nothing the model just said. A target that fits the whole history returns 0.
 */
const retainedFrom = (derived: ReadonlyArray<DerivedMessage>, retainTokens: number): number => {
  const target = Math.max(0, retainTokens)
  let index = derived.length
  let kept = 0
  while (index > 0) {
    const entry = derived[index - 1]
    if (entry === undefined) break
    const tokens = messageTokens(entry.message)
    if (index < derived.length && kept + tokens > target) break
    kept += tokens
    index -= 1
  }
  return index
}

/**
 * What the next request stops carrying: every message outside the retention whose
 * content is over the price, with what it carries instead. Pure, so the loop can
 * record the decision before the request that follows it. An already-pruned log
 * yields nothing, so recording it again is not possible.
 */
export function pruneFor(
  events: ReadonlyArray<SessionEvent>,
  options: CompactOptions,
): CompactionPrune | undefined {
  const derived = deriveMessagesWithSeqs(events)
  const boundary = retainedFrom(derived, options.retainTokens)
  const alreadyPruned = prunedSeqs(events)
  // The newest system prompt is the request's frame, not history: a prune never hides
  // it. An older one was the frame once, so it folds like any other message.
  const frame = latestSystemSeq(events)
  // A checkpoint is already the condensed form; stubbing it would hide the summary.
  const checkpoints = new Set(
    events.filter((event) => event.type === 'compaction/checkpoint').map((event) => event.seq),
  )
  // The newest runtime snapshot says who is asking now: the request keeps it whole.
  const runtimeContext = lastRuntimeContextSeq(events)
  const replacements: Array<CompactReplacement> = []
  let shadowedBytes = 0

  derived.forEach((entry, index) => {
    if (
      index >= boundary ||
      alreadyPruned.has(entry.seq) ||
      entry.seq === frame ||
      entry.seq === runtimeContext ||
      checkpoints.has(entry.seq)
    ) {
      return
    }
    const pruned = pruneBlocks(entry.message.content, {
      maxBytes: options.maxBytes,
      toolResult: entry.message.role === 'tool',
    })
    if (!pruned.changed) return
    shadowedBytes += pruned.replacedBytes
    replacements.push({ seq: entry.seq, content: pruned.content })
  })
  if (replacements.length === 0) return undefined

  const seqs = replacements.map((replacement) => replacement.seq)
  return {
    shadowedSeqs: seqs,
    shadowedRange: { start: Math.min(...seqs), end: Math.max(...seqs) },
    shadowedBytes,
    replacements,
  }
}

/**
 * The messages a summary would stand for: everything outside the retention, in
 * order, without the newest system prompt (the request's frame, not history). An
 * older prompt is history and enters the summary. Already checkpointed or pruned
 * messages are gone from the fold and never come back here. The newest runtime
 * snapshot stays as well: a summary may condense the past, not change who is asking.
 */
export function summarizableMessages(
  events: ReadonlyArray<SessionEvent>,
  options: CompactOptions,
): ReadonlyArray<DerivedMessage> {
  const derived = deriveMessagesWithSeqs(events)
  const boundary = retainedFrom(derived, options.retainTokens)
  const frame = latestSystemSeq(events)
  const runtimeContext = lastRuntimeContextSeq(events)
  return derived
    .slice(0, boundary)
    .filter((entry) => entry.seq !== frame && entry.seq !== runtimeContext)
}

/** The range as the request would carry it: a recorded prune's replacements applied. */
export const messagesWithPrune = (
  messages: ReadonlyArray<DerivedMessage>,
  prune: CompactionPrune | undefined,
): ReadonlyArray<RequestMessage> =>
  (prune === undefined ? messages : applyReplacements(messages, prune.replacements)).map(
    (entry) => entry.message,
  )

const summaryMessage = (seq: SessionSeq, summary: string): DerivedMessage => ({
  seq,
  message: {
    role: 'user',
    content: [{ type: 'text', text: CHECKPOINT_PREAMBLE + summary }],
  },
})

/**
 * Replaces the summarized span with the one checkpoint message, where the span
 * began. A span an earlier checkpoint already replaced is left alone, so folding
 * the log twice cannot stack two summaries.
 */
const applyCheckpoint = (
  derived: ReadonlyArray<DerivedMessage>,
  event: SessionEvent & { readonly type: 'compaction/checkpoint' },
): ReadonlyArray<DerivedMessage> => {
  const shadowed = new Set(event.data.shadowedSeqs)
  if (!derived.some((entry) => shadowed.has(entry.seq))) return derived
  const kept: Array<DerivedMessage> = []
  let placed = false
  for (const entry of derived) {
    if (!shadowed.has(entry.seq)) {
      kept.push(entry)
      continue
    }
    if (!placed) {
      kept.push(summaryMessage(event.seq, event.data.summary))
      placed = true
    }
  }
  return kept
}

/** Rewrites the folded history so a recorded checkpoint stands for its span. */
export const checkpointProjection: MessageProjection = {
  type: 'compaction/checkpoint',
  name: 'compaction/checkpoint',
  project: (event, derived) =>
    event.type === 'compaction/checkpoint' ? applyCheckpoint(derived, event) : derived,
}

registerMessageProjection(checkpointProjection)

/** The instruction the auxiliary summarizer call answers with the checkpoint. */
export const COMPACT_SUMMARY_INSTRUCTION = [
  'You are now acting as a compaction engine for this coding assistant. Condense the',
  'conversation ABOVE into a structured checkpoint that lets another model resume the',
  'work without losing essential context.',
  '',
  'Output exactly this Markdown structure, keeping every section in order; write',
  '"(none)" for an empty section and never drop one:',
  '',
  '## Primary Request and Intent',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, and numbers.',
  '- Do not mention this summarization request or that the context was compacted.',
  '- Answer with the checkpoint text only; call no tool and take no other action.',
].join('\n')

/** The event data one summarized range becomes. */
export const checkpointOf = (
  range: ReadonlyArray<DerivedMessage>,
  summary: string,
  model: { readonly provider: string; readonly model: string },
): CompactionCheckpoint | undefined => {
  const first = range[0]
  if (first === undefined || summary.trim() === '') return undefined
  const seqs = range.map((entry) => entry.seq)
  return {
    shadowedSeqs: seqs,
    // The fold holds the previous summary at the head of its span with the seq the
    // checkpoint was recorded at, newer than the messages after it, so the range
    // names the oldest and the newest seq rather than the two ends.
    shadowedRange: { start: Math.min(...seqs), end: Math.max(...seqs) },
    summary,
    provider: model.provider,
    model: model.model,
  }
}
