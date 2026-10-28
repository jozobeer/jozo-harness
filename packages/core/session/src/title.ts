import type { SessionEvent, TitleSource } from './events.ts'

/** How long a title may be, in code units. */
export const TITLE_MAX_CHARS = 120

/** Which name wins when a log holds several: a human's, the model's, the fallback. */
export const TITLE_RANK: Readonly<Record<TitleSource, number>> = {
  human: 0,
  model: 1,
  fallback: 2,
}

/** The first message only names a session no written title reached. */
export const FIRST_MESSAGE_TITLE_RANK = 3

/** One name found in a log, with how strongly it claims the session. */
export interface TitleCandidate {
  readonly title: string
  readonly rank: number
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** One line, trimmed, and no longer than a title should be. */
export const shortenTitle = (text: string, maxChars: number = TITLE_MAX_CHARS): string => {
  // A model told one length still gets the log's limit: a stored title is a line
  // every list can draw, not a paragraph one reader has to clip.
  const limit = Math.max(1, Math.min(maxChars, TITLE_MAX_CHARS))
  const line = oneLine(text)
  return line.length <= limit ? line : line.slice(0, limit - 1) + '…'
}

/**
 * The title a decoded log record carries, or undefined when the record is not the
 * human's own message. The body arrives as unknown: a record that does not read as
 * one is not a title, and the next one may be.
 */
export const titleOfRecord = (type: unknown, data: unknown): string | undefined => {
  if (type !== 'user/message') return undefined
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { readonly source?: unknown; readonly text?: unknown }
  if (record.source !== 'user' || typeof record.text !== 'string') return undefined
  return shortenTitle(record.text)
}

/** One written title as the log holds it, or undefined when the record is not one. */
export const titleEventOfRecord = (
  type: unknown,
  data: unknown,
): { readonly title: string; readonly source: TitleSource } | undefined => {
  if (type !== 'session/title') return undefined
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { readonly title?: unknown; readonly source?: unknown }
  if (typeof record.title !== 'string' || record.title === '') return undefined
  if (record.source !== 'model' && record.source !== 'human' && record.source !== 'fallback') {
    return undefined
  }
  return { title: shortenTitle(record.title), source: record.source }
}

/** The name one event claims, if it claims one. */
export const titleCandidateOf = (event: SessionEvent): TitleCandidate | undefined => {
  const written = titleEventOfRecord(event.type, event.data)
  if (written !== undefined) {
    return { title: written.title, rank: TITLE_RANK[written.source] }
  }
  const first = titleOfRecord(event.type, event.data)
  return first === undefined || first === ''
    ? undefined
    : { title: first, rank: FIRST_MESSAGE_TITLE_RANK }
}

/** The stronger of two names; the first one keeps a tie. */
export const betterTitle = (
  current: TitleCandidate | undefined,
  next: TitleCandidate | undefined,
): TitleCandidate | undefined =>
  next === undefined || (current !== undefined && current.rank <= next.rank) ? current : next

/**
 * The name of a session, from the strongest thing that named it rather than the
 * last: a human's name outranks the model's whatever the order, a model's outranks
 * the fallback it may have replaced, and the first message names a session nobody
 * named yet.
 */
export const titleOf = (events: ReadonlyArray<SessionEvent>): string =>
  events.reduce<TitleCandidate | undefined>(
    (best, event) => betterTitle(best, titleCandidateOf(event)),
    undefined,
  )?.title ?? ''
