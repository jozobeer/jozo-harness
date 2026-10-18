import type { FileMatches } from './state.ts'

/** The reference word under the caret: where it starts, and what it holds. */
export interface ReferenceToken {
  /** The whole word, leading @ included: what a candidate replaces. */
  readonly text: string
  /** Where the @ sits. */
  readonly start: number
  /** One past the word, so accepting a candidate replaces all of it. */
  readonly end: number
  /** What was typed between the @ and the caret, without the @. */
  readonly query: string
}

/** A boundary a reference may open at: the start of the text, or whitespace. */
const opensAt = (text: string, at: number): boolean => at === 0 || /\s/.test(text[at - 1] ?? '')

/**
 * The @word a caret sits in, or nothing. An @ opens a reference only at the
 * start of the text or after whitespace, so an address in a sentence stays
 * text; a caret past the word, on a space, has left it.
 */
export const referenceTokenAt = (text: string, caret: number): ReferenceToken | undefined => {
  const at = Math.max(0, Math.min(caret, text.length))
  const start = text.lastIndexOf('@', at - 1)
  if (start === -1 || !opensAt(text, start)) return undefined
  const before = text.slice(start + 1, at)
  if (/\s/.test(before)) return undefined
  const after = text.slice(at)
  const space = after.search(/\s/)
  const end = space === -1 ? text.length : at + space
  return { text: text.slice(start, end), start, end, query: before }
}

/** The text and caret after accepting one path: @path and a space to write after it. */
export const completedReference = (
  text: string,
  token: ReferenceToken,
  path: string,
): { readonly text: string; readonly caret: number } => {
  const replacement = '@' + path + ' '
  return {
    text: text.slice(0, token.start) + replacement + text.slice(token.end),
    caret: token.start + replacement.length,
  }
}

/**
 * The paths a page may show for one word: the answer belongs to the session
 * and the word that asked for it, so a late answer never lands on another one.
 */
export const referencesFor = (
  matches: FileMatches | undefined,
  sessionId: string,
  token: ReferenceToken,
): ReadonlyArray<string> =>
  matches !== undefined && matches.sessionId === sessionId && matches.query === token.query
    ? matches.paths
    : []
