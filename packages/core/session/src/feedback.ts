import { Data, Effect, Schema } from 'effect'
import type { SessionSeq } from './events.ts'
import type { SessionError } from './errors.ts'
import type { Session } from './session.ts'
import { registerLogOnlySessionEvents } from './projections.ts'
import { registerSessionEventSchemas, type SessionEventSchemaMap } from './schemas.ts'

/** The longest memo a rating may carry, counted in code points. */
export const FEEDBACK_MEMO_LIMIT = 500

/** The verdicts a human can give one answer. */
export const FEEDBACK_RATINGS = ['like', 'dislike'] as const

export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number]

/**
 * A human's verdict on one answer. The target is the seq of the assistant
 * message; a later rating of the same target wins when the log is folded.
 */
export interface FeedbackRatedData {
  readonly target: SessionSeq
  readonly rating: FeedbackRating
  readonly memo?: string
}

declare module './events.ts' {
  interface SessionEventMap {
    'feedback/rated': FeedbackRatedData
  }
}

/** Schemas for the session events this module adds. */
export const feedbackEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  [
    'feedback/rated',
    Schema.Struct({
      target: Schema.Int,
      rating: Schema.Literals(FEEDBACK_RATINGS),
      memo: Schema.optionalKey(Schema.String),
    }),
  ],
])

registerSessionEventSchemas(feedbackEventSchemas)
// An answer's rating is the human's note about it: the page draws it, the next
// request never reads it.
registerLogOnlySessionEvents(['feedback/rated'])

/** Why a rating could not be written. */
export class FeedbackError extends Data.TaggedError('FeedbackError')<{
  readonly code: 'bad-target' | 'memo-too-long' | 'no-answer'
  readonly message: string
}> {}

/** The newest assistant message that said something: the answer a bare rating names. */
export const newestAnswerSeq = (
  events: ReadonlyArray<{ readonly type: string; readonly seq: number; readonly data: unknown }>,
): SessionSeq | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const content = (
      event.data as {
        readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
      }
    ).content
    if (
      content?.some((block) => block.type === 'text' && (block.text ?? '').trim() !== '') === true
    ) {
      return event.seq
    }
  }
  return undefined
}

/** The latest rating of every target; a second rating of one answer replaces the first. */
export const feedbackOf = (
  events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>,
): ReadonlyMap<SessionSeq, FeedbackRatedData> => {
  const byTarget = new Map<SessionSeq, FeedbackRatedData>()
  for (const event of events) {
    if (event.type !== 'feedback/rated') continue
    const data = event.data as FeedbackRatedData
    byTarget.set(data.target, data)
  }
  return byTarget
}

/** What one rating names, before target and memo are checked. */
export interface FeedbackRequest {
  readonly rating: FeedbackRating
  /** The answer to rate; absent names the newest answer. */
  readonly target?: SessionSeq
  readonly memo?: string
}

/**
 * Writes one rating. The target must be an assistant message already in the
 * log, so a page never attaches a verdict to an answer nobody sees.
 */
export const rateFeedback = (
  session: Session,
  request: FeedbackRequest,
): Effect.Effect<FeedbackRatedData, FeedbackError | SessionError> =>
  Effect.gen(function* () {
    const events = session.events()
    const target = request.target ?? newestAnswerSeq(events)
    if (target === undefined) {
      return yield* Effect.fail(
        new FeedbackError({ code: 'no-answer', message: 'there is no answer to rate yet' }),
      )
    }
    if (!events.some((event) => event.seq === target && event.type === 'assistant/message')) {
      return yield* Effect.fail(
        new FeedbackError({
          code: 'bad-target',
          message: 'the target is not an assistant message: #' + String(target),
        }),
      )
    }
    const memo = request.memo?.trim()
    if (memo !== undefined && Array.from(memo).length > FEEDBACK_MEMO_LIMIT) {
      return yield* Effect.fail(
        new FeedbackError({
          code: 'memo-too-long',
          message: 'the memo is longer than ' + String(FEEDBACK_MEMO_LIMIT) + ' characters',
        }),
      )
    }
    const data: FeedbackRatedData = {
      target,
      rating: request.rating,
      ...(memo === undefined || memo === '' ? {} : { memo }),
    }
    yield* session.append('feedback/rated', data)
    return data
  })
