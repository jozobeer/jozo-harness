import type { ContentBlock } from '@jozo-harness/llm'
import { Effect } from 'effect'
import type { ToolExecutionResult } from './types.ts'

/** Bytes one token carries on average; the budget is estimated rather than counted. */
export const BYTES_PER_TOKEN = 4

/** How many characters of a spilled result stay at its head. */
export const SPILL_PREVIEW_CHARS = 2000

/** How many characters of a spilled result stay at its tail. */
export const SPILL_TAIL_CHARS = 500

const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/** Tokens in a text, at four bytes per token; no provider tokenizer is worth a round trip. */
export const estimateTokens = (text: string): number => Math.ceil(bytesOf(text) / BYTES_PER_TOKEN)

export type SpillPlan =
  | { readonly kind: 'keep' }
  | {
      readonly kind: 'spill'
      /** The text that should be written next to the session. */
      readonly text: string
      /** What the model sees instead: the head, a marker, and the tail. */
      readonly head: string
      readonly tail: string
      /** Bytes left out between the head and the tail. */
      readonly omittedBytes: number
      readonly tokens: number
      readonly bytes: number
      readonly lines: number
    }

/** Tools whose result is never written away: reading it again is the way back. */
const REREADABLE = new Set(['read'])

/** The plain text of a result: text blocks joined, other blocks ignored. */
export const textOf = (content: ReadonlyArray<ContentBlock>): string =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

/** The head and tail of a text that does not fit, sliced by code point so a pair cannot split. */
const endsOf = (
  points: ReadonlyArray<string>,
  headChars: number,
  tailChars: number,
): { readonly head: string; readonly tail: string; readonly omittedBytes: number } => {
  const head = Math.min(headChars, Math.max(1, points.length - 1))
  const tail = Math.min(tailChars, points.length - head - 1)
  return {
    head: points.slice(0, head).join(''),
    tail: tail <= 0 ? '' : points.slice(points.length - tail).join(''),
    omittedBytes: bytesOf(points.slice(head, points.length - tail).join('')),
  }
}

/**
 * Decides whether a result is too large to keep. Large results are written to
 * a file, and the model keeps their head and tail along with the way back.
 */
export function planSpill(
  content: ReadonlyArray<ContentBlock>,
  maxTokens: number,
  headChars = SPILL_PREVIEW_CHARS,
  tailChars = SPILL_TAIL_CHARS,
): SpillPlan {
  const text = textOf(content)
  const tokens = estimateTokens(text)
  const points = Array.from(text)
  if (tokens <= maxTokens || points.length < 2) return { kind: 'keep' }
  const ends = endsOf(points, headChars, tailChars)
  return {
    kind: 'spill',
    text,
    head: ends.head,
    tail: ends.tail,
    omittedBytes: ends.omittedBytes,
    tokens,
    bytes: bytesOf(text),
    lines: text.split('\n').length,
  }
}

/** How the pipeline writes a spilled result away; returns the reference to show. */
export type SpillWriter = (callId: string, text: string) => Effect.Effect<string>

/** How the pipeline writes an image away; returns the path read_image can open. */
export type SpillImageWriter = (
  callId: string,
  data: string,
  mediaType: string,
) => Effect.Effect<string>

/** Where a tool's complete result can be stored: the call it belongs to, and the store. */
export interface SpillTarget {
  readonly callId: string
  readonly spill?: SpillWriter
}

/**
 * Stores the complete text of a paged result next to the session and returns the
 * locator, or undefined when there is no store or it cannot write. A tool that
 * cannot store its overflow says how to narrow the search instead of failing.
 */
export const writeSpill = (
  target: SpillTarget,
  suffix: string,
  text: string,
): Effect.Effect<string | undefined> =>
  target.spill === undefined
    ? Effect.succeed(undefined)
    : target
        .spill(target.callId + '-' + suffix, text)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))

/** The call a result belongs to, as much of it as the spill policy reads. */
export interface SpillSubject {
  readonly callId: string
  readonly tool: string
}

export interface SpillOptions {
  /** Results estimated above this many tokens are written away. Unset means no spilling. */
  readonly maxSpillTokens?: number
  readonly spill?: SpillWriter
  /** Image overflow needs its own writer: its bytes are not UTF-8 text. */
  readonly spillImage?: SpillImageWriter
}

/** The line that separates the head and tail and says how to read what is missing. */
const omission = (omittedBytes: number, path: string): string =>
  '\n… middle omitted (' + String(omittedBytes) + ' bytes); read ' + path + '\n'

const spilledText = (plan: Extract<SpillPlan, { kind: 'spill' }>, path: string): string =>
  plan.head + omission(plan.omittedBytes, path) + plan.tail

const isImage = (block: ContentBlock): block is Extract<ContentBlock, { type: 'image' }> =>
  block.type === 'image'

/** What a result costs, both its text and the images the request would carry. */
const tokensOf = (content: ReadonlyArray<ContentBlock>): number =>
  estimateTokens(textOf(content)) +
  content.reduce(
    (sum, block) => (block.type === 'image' ? sum + estimateTokens(block.data) : sum),
    0,
  )

const offloadText = (
  plan: SpillPlan,
  write: SpillWriter | undefined,
  callId: string,
): Effect.Effect<string | undefined> =>
  plan.kind === 'keep' || write === undefined
    ? Effect.succeed(undefined)
    : write(callId, plan.text).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

const offloadImage = (
  image: Extract<ContentBlock, { type: 'image' }>,
  write: SpillImageWriter | undefined,
  callId: string,
  index: number,
): Effect.Effect<ContentBlock | undefined> =>
  write === undefined
    ? Effect.succeed(undefined)
    : write(callId + '-image-' + String(index), image.data, image.mediaType).pipe(
        Effect.map((path): ContentBlock => ({
          type: 'text',
          text: '[image ' + path + '; show it again with the read_image tool]',
        })),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

/**
 * Replaces an oversized result with its ends and a reference. Errors are left
 * alone: the model needs to see what failed. Tools whose result can be read again
 * are left alone too, because spilling them would hide the way back. A store that
 * cannot write leaves the content inline rather than failing the call. Images are
 * written as files because base64 in the request is the cost being removed.
 */
const shouldSpill = (
  result: ToolExecutionResult,
  subject: SpillSubject,
  options: SpillOptions,
): boolean => {
  const budget = options.maxSpillTokens
  if (budget === undefined || result.isError || REREADABLE.has(subject.tool)) return false
  if (options.spill === undefined && options.spillImage === undefined) return false
  return tokensOf(result.content) > budget
}

export function applySpill(
  result: ToolExecutionResult,
  subject: SpillSubject,
  options: SpillOptions,
): Effect.Effect<ToolExecutionResult> {
  return Effect.gen(function* () {
    if (!shouldSpill(result, subject, options)) return result
    const budget = options.maxSpillTokens ?? 0

    const text = textOf(result.content)
    const plan = planSpill(result.content, budget)
    const reference = yield* offloadText(plan, options.spill, subject.callId)
    const images = result.content.filter(isImage)
    const locators = yield* Effect.forEach(images, (image, index) =>
      offloadImage(image, options.spillImage, subject.callId, index),
    )
    if (reference === undefined && locators.every((locator) => locator === undefined)) {
      return result
    }
    const keptText = reference === undefined ? text : spilledText(plan, reference)
    const content: Array<ContentBlock> = []
    let emittedText = false
    let imageIndex = 0
    for (const block of result.content) {
      if (block.type === 'text') {
        if (emittedText) continue
        emittedText = true
        content.push({ type: 'text', text: keptText })
      } else if (block.type === 'image') {
        content.push(locators[imageIndex] ?? block)
        imageIndex += 1
      } else {
        content.push(block)
      }
    }
    return { ...result, content }
  })
}