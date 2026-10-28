import type { TimedStreamChunk } from '@jozo-harness/llm'
import { StreamChunkSchema } from '@jozo-harness/llm'
import type {
  ApprovalRequested,
  AskAnswer,
  AskBatchRequested,
  AskRequested,
} from '@jozo-harness/safety'
import {
  QuoteSchema,
  ReferenceSchema,
  type FeedbackError,
  type FeedbackRating,
  type Quote,
  type Reference,
  type SessionError,
  type SessionEvent,
} from '@jozo-harness/session'

/** The passage shape a page sends with a message; the session owns it. */
export { QuoteSchema, type Quote }

/**
 * The attached file or session shape, its budget, and its cut. The page and the
 * server read them from here, so neither needs the session package's whole face.
 */
export {
  REFERENCE_LIMITS,
  ReferenceSchema,
  clipReferences,
  type Reference,
  type SessionError,
  type SessionEvent,
  type SessionSummary,
} from '@jozo-harness/session'
import { Effect, Schema, Stream } from 'effect'

/**
 * How a submitted line meets a running turn: 'queue' waits for the next turn,
 * 'steer' joins the running turn at its next step. Absent means 'queue'.
 */
export const SubmitModeSchema = Schema.Literals(['queue', 'steer'])

export type SubmitMode = typeof SubmitModeSchema.Type

/** One command a UI sends to the core. Serializable so a transport can carry it. */
export const UiCommandSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('submit'),
    text: Schema.String,
    mode: Schema.optionalKey(SubmitModeSchema),
    /** Passages the human selected from earlier turns; they ride with the text. */
    quotes: Schema.optionalKey(Schema.Array(QuoteSchema)),
    /** Files and sessions the human pointed at with @; they ride with the text. */
    references: Schema.optionalKey(Schema.Array(ReferenceSchema)),
  }),
  Schema.Struct({
    kind: Schema.Literal('approve'),
    callId: Schema.String,
    approved: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal('answer'), id: Schema.String, answer: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('cancel') }),
  // '' is the UI's way of leaving the choice to the provider.
  Schema.Struct({ kind: Schema.Literal('effort'), effort: Schema.String }),
  // What this session runs on from its next request: `provider/model`.
  Schema.Struct({ kind: Schema.Literal('model'), model: Schema.String }),
  // A verdict on one answer, named by the seq of its assistant message.
  Schema.Struct({
    kind: Schema.Literal('feedback'),
    target: Schema.Int,
    // The page must not pull the whole session package in for the two words it
    // checks; the type import still makes the host read them as FeedbackRating.
    rating: Schema.Literals(['like', 'dislike']),
    memo: Schema.optionalKey(Schema.String),
  }),
])

export type UiCommand = typeof UiCommandSchema.Type

/**
 * One logged event as the UI sees it. The envelope is what a transport can
 * check; the body stays unknown because plugins own its shape.
 */
export const UiSessionEventSchema = Schema.Struct({
  seq: Schema.Int,
  time: Schema.Number,
  type: Schema.String,
  data: Schema.Unknown,
  ignorable: Schema.optionalKey(Schema.Literal(true)),
})

export type UiSessionEvent = typeof UiSessionEventSchema.Type

/** A stream chunk with the time it was received. Only text deltas reach a UI. */
export const UiStreamChunkSchema = Schema.Struct({
  time: Schema.Number,
  chunk: StreamChunkSchema,
})

export type UiStreamChunk = typeof UiStreamChunkSchema.Type

/**
 * What a UI renders. History arrives as `session` events when a UI subscribes,
 * so the boundary between history and live is the same shape.
 */
export const UiEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('session'), event: UiSessionEventSchema }),
  Schema.Struct({ kind: Schema.Literal('stream'), chunk: UiStreamChunkSchema }),
])

export type UiEvent = typeof UiEventSchema.Type

/**
 * Restores the logged typing of a session event. The transport validated the
 * envelope and the log is the only writer of the body.
 */
export const sessionEventOf = (event: UiSessionEvent): SessionEvent =>
  event as unknown as SessionEvent

/** A stream chunk with its assembled type restored. */
export const timedStreamChunkOf = (chunk: UiStreamChunk): TimedStreamChunk => chunk

/**
 * The UI-facing face of one running core: a stream of what happened and the
 * commands that change it. UIs do not receive functions or closures from the
 * core, only these.
 */
export interface UiHost {
  readonly events: Stream.Stream<UiEvent>
  /**
   * Queues a user message: for the next turn by default, or for the running
   * turn's next step when the mode is 'steer'. The line still falls back to the
   * next turn when nothing is running, because a steer starts one.
   */
  readonly submit: (
    text: string,
    mode?: SubmitMode,
    quotes?: ReadonlyArray<Quote>,
    references?: ReadonlyArray<Reference>,
  ) => Effect.Effect<void, SessionError>
  /** Answers one approval request. */
  readonly approve: (callId: string, approved: boolean) => Effect.Effect<void>
  /** Answers one question; the answer may have to be written down, so it can fail. */
  readonly answer: (id: string, answer: string) => Effect.Effect<void, SessionError>
  /** Cancels the running turn; a no-op while idle. */
  readonly cancel: () => Effect.Effect<void>
  /**
   * Switches the reasoning effort this session asks the provider for. It lands
   * on the request after the switch; '' leaves the choice to the provider.
   */
  readonly setEffort: (effort: string) => Effect.Effect<void>
  /**
   * Switches the route this session asks, as `provider/model`. It lands on the
   * request after the switch, and the session keeps it until it is switched
   * again.
   */
  readonly setModel: (model: string) => Effect.Effect<void>
  /** The approval answerer handed to `installApproval`. */
  readonly answerApproval: (request: ApprovalRequested) => Effect.Effect<boolean>
  /** The answerer handed to `installAsk`. */
  readonly answerAsk: (request: AskRequested) => Effect.Effect<string>
  /** The batch answerer handed to `installAsk`; absent means a batch fails at once. */
  readonly serveQuestions: (request: AskBatchRequested) => Effect.Effect<ReadonlyArray<AskAnswer>>
  /**
   * Rates one answer, named by the seq of its assistant message. The rating is
   * the human's: it reaches the page and never the next request.
   */
  readonly rate: (
    target: number,
    rating: FeedbackRating,
    memo?: string,
  ) => Effect.Effect<void, SessionError | FeedbackError>
}

/** Runs one command against a host; the transports share this mapping. */
export const sendCommand = (
  host: UiHost,
  command: UiCommand,
): Effect.Effect<void, SessionError | FeedbackError> => {
  switch (command.kind) {
    case 'submit':
      return host.submit(command.text, command.mode, command.quotes, command.references)
    case 'approve':
      return host.approve(command.callId, command.approved)
    case 'answer':
      return host.answer(command.id, command.answer)
    case 'cancel':
      return host.cancel()
    case 'effort':
      return host.setEffort(command.effort)
    case 'model':
      return host.setModel(command.model)
    case 'feedback':
      return host.rate(command.target, command.rating, command.memo)
  }
}
