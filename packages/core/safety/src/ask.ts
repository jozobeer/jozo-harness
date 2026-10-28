import { Context, Data, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from 'effect'
import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type Session,
  type SessionEventSchemaMap,
} from '@jozo-harness/session'

/** One choice a question offers. */
export interface AskQuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question in a batch. The id is stable within the call and echoed in the answer. */
export interface AskQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options: ReadonlyArray<AskQuestionOption>
  readonly multiSelect: boolean
}

/**
 * Turns the one string a single-question UI returns into the batch answer shape.
 * A label selects that option, several comma-separated labels select several,
 * and anything else is free-form text.
 */
export const answerOf = (question: AskQuestion, answer: string): AskAnswer => {
  const labels = question.options.map((option) => option.label)
  const selected = question.multiSelect
    ? answer
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
    : [answer]
  if (selected.length > 0 && selected.every((label) => labels.includes(label))) {
    return { id: question.id, selected }
  }
  return {
    id: question.id,
    selected: [],
    ...(answer === '' ? {} : { custom: answer }),
  }
}

/** The user message that carries a late answer back into the session. */
export const lateAnswerMessage = (answered: AskBatchAnswered): string =>
  'The user answered ask_user call ' +
  answered.callId +
  ':\n' +
  answered.answers
    .map((answer) => {
      const parts = [...answer.selected]
      if (answer.custom !== undefined && answer.custom !== '') parts.push(answer.custom)
      return '- ' + answer.id + ': ' + (parts.length === 0 ? '(skipped)' : parts.join(', '))
    })
    .join('\n')

/** A batch of questions one tool call asks at once. */
export interface AskBatchRequested {
  /** The tool call that asked, so a late answer can name it. */
  readonly callId: string
  readonly questions: ReadonlyArray<AskQuestion>
}

/** One answer in a batch. An empty selection without custom text is an explicit skip. */
export interface AskAnswer {
  readonly id: string
  readonly selected: ReadonlyArray<string>
  readonly custom?: string
}

/** The answers a batch settled with; late ones carry the call they answer. */
export interface AskBatchAnswered {
  readonly callId: string
  readonly answers: ReadonlyArray<AskAnswer>
}

/** Either every question was answered, or the wait ended with unanswered questions left pending. */
export type AskBatchOutcome =
  | { readonly _tag: 'answered'; readonly answers: ReadonlyArray<AskAnswer> }
  | {
      readonly _tag: 'pending'
      readonly callId: string
      readonly unanswered: ReadonlyArray<string>
    }

/** A question for the user, with the choices the model offered. Kept for plan mode and computer use. */
export interface AskRequested {
  readonly id: string
  readonly question: string
  readonly options: ReadonlyArray<string>
}

/** The answer to one question. */
export interface AskAnswered {
  readonly id: string
  readonly answer: string
}

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'interaction/ask/requested': AskRequested
    'interaction/ask/answered': AskAnswered
    'interaction/ask/questions': AskBatchRequested
    'interaction/ask/answers': AskBatchAnswered
    'interaction/ask/pending': {
      readonly callId: string
      readonly unanswered: ReadonlyArray<string>
    }
  }
}

const AskQuestionSchema = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  header: Schema.optionalKey(Schema.String),
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.optionalKey(Schema.String),
    }),
  ),
  multiSelect: Schema.Boolean,
})

const AskRequestedSchema = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
})

const AskAnsweredSchema = Schema.Struct({
  id: Schema.String,
  answer: Schema.String,
})

const AskBatchRequestedSchema = Schema.Struct({
  callId: Schema.String,
  questions: Schema.Array(AskQuestionSchema),
})

/** The answer shape a UI sends back for one question. */
export const AskAnswerSchema = Schema.Struct({
  id: Schema.String,
  selected: Schema.Array(Schema.String),
  custom: Schema.optionalKey(Schema.String),
})

const AskBatchAnsweredSchema = Schema.Struct({
  callId: Schema.String,
  answers: Schema.Array(AskAnswerSchema),
})

const AskPendingSchema = Schema.Struct({
  callId: Schema.String,
  unanswered: Schema.Array(Schema.String),
})

/** Schemas for the session events this module adds. */
export const askEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  ['interaction/ask/requested', AskRequestedSchema],
  ['interaction/ask/answered', AskAnsweredSchema],
  ['interaction/ask/questions', AskBatchRequestedSchema],
  ['interaction/ask/answers', AskBatchAnsweredSchema],
  ['interaction/ask/pending', AskPendingSchema],
])

registerSessionEventSchemas(askEventSchemas)
// A question and its answer are for the UI; the model sees the tool result or a later user message.
registerLogOnlySessionEvents([
  'interaction/ask/requested',
  'interaction/ask/answered',
  'interaction/ask/questions',
  'interaction/ask/answers',
  'interaction/ask/pending',
])

/** A question with nobody to answer it. The caller continues without the answer. */
export class AskUnavailable extends Data.TaggedError('AskUnavailable')<{
  readonly id: string
  readonly message: string
}> {}

/** Answers one question; the UI or a caller supplies it. */
export type AskAnswerer = (request: AskRequested) => Effect.Effect<string>

/** Answers a batch of questions; the UI or a caller supplies it. */
export type AskBatchAnswerer = (
  request: AskBatchRequested,
) => Effect.Effect<ReadonlyArray<AskAnswer>>

/** Receives answers that arrive after a batch already returned as pending. */
export type AskLateAnswerHandler = (answered: AskBatchAnswered) => Effect.Effect<void>

export interface AskShape {
  /**
   * Installs the answerer every later question goes to. While nobody is served a
   * question fails at once, because a seam with no answerer fails rather than
   * waits forever for one that will never come.
   */
  readonly serve: (answerer: AskAnswerer) => Effect.Effect<void>
  /** Installs the answerer every later batch goes to. */
  readonly serveBatch: (answerer: AskBatchAnswerer) => Effect.Effect<void>
  /** Says that nobody answers any more; later questions and batches fail at once. */
  readonly stopServing: () => Effect.Effect<void>
  /** Whether somebody is there to answer. */
  readonly served: () => boolean
  /** Whether somebody is there to answer a batch. */
  readonly batchServed: () => boolean
  /**
   * Asks one question and waits for its answer. Asking with nobody served is a
   * failure the model can read, not a hang.
   */
  readonly ask: (request: AskRequested) => Effect.Effect<string, AskUnavailable>
  /**
   * Asks a batch. With a time limit, the wait ends at that many milliseconds and
   * answers that arrive later go to the late-answer handlers instead.
   */
  readonly askBatch: (
    request: AskBatchRequested,
    timeLimitMs?: number,
  ) => Effect.Effect<AskBatchOutcome, AskUnavailable>
  /**
   * Registers a receiver for answers that arrive after a batch returned pending.
   * The answerer keeps waiting, so a human can still reply without a second card.
   * Registration is synchronous so a wrapper can install it while it is built.
   */
  readonly onLateAnswer: (handler: AskLateAnswerHandler) => void
}

/** Answers live in memory only: a question is asked once and never replayed. */
export const makeAsk = (
  options: {
    /** Default wait for a batch; absent means wait until answered. */
    readonly timeLimitMs?: number
  } = {},
): Effect.Effect<AskShape> =>
  Effect.sync(() => {
    let answerer: AskAnswerer | undefined
    let batchAnswerer: AskBatchAnswerer | undefined
    const lateHandlers = new Set<AskLateAnswerHandler>()

    const notifyLate = (answered: AskBatchAnswered): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const handler of lateHandlers) {
          yield* handler(answered).pipe(Effect.ignore)
        }
      })

    return {
      serve: (answer) =>
        Effect.sync(() => {
          answerer = answer
        }),
      serveBatch: (answer) =>
        Effect.sync(() => {
          batchAnswerer = answer
        }),
      stopServing: () =>
        Effect.sync(() => {
          answerer = undefined
          batchAnswerer = undefined
        }),
      served: () => answerer !== undefined,
      batchServed: () => batchAnswerer !== undefined,
      ask: (request) =>
        answerer === undefined
          ? Effect.fail(
              new AskUnavailable({
                id: request.id,
                message:
                  'nobody is listening to answer this question; the run has no interactive user, so continue without asking',
              }),
            )
          : answerer(request),
      askBatch: (request, timeLimitMs) =>
        Effect.gen(function* () {
          if (batchAnswerer === undefined) {
            return yield* Effect.fail(
              new AskUnavailable({
                id: request.callId,
                message:
                  'nobody is listening to answer these questions; the run has no interactive user, so continue without asking',
              }),
            )
          }
          const wait = batchAnswerer
          const limit = timeLimitMs ?? options.timeLimitMs
          if (limit === undefined) {
            return { _tag: 'answered' as const, answers: yield* wait(request) }
          }
          // The answerer is detached from the timed wait: a timeout ends this
          // call, not the human's chance to answer, so a late reply still lands.
          const waiting = yield* Effect.forkDetach(wait(request))
          const settled = yield* Fiber.join(waiting).pipe(
            Effect.timeoutOption(Duration.millis(limit)),
          )
          if (Option.isSome(settled)) {
            return { _tag: 'answered' as const, answers: settled.value }
          }
          yield* Effect.forkDetach(
            Fiber.await(waiting).pipe(
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit)
                  ? notifyLate({ callId: request.callId, answers: exit.value })
                  : Effect.void,
              ),
            ),
          )
          return {
            _tag: 'pending' as const,
            callId: request.callId,
            unanswered: request.questions.map((question) => question.id),
          }
        }),
      onLateAnswer: (handler) => {
        lateHandlers.add(handler)
      },
    }
  })

export class Ask extends Context.Service<Ask, AskShape>()('jozo-harness/Ask') {}

export const askServiceLayer: Layer.Layer<Ask, never> = Layer.effect(Ask, makeAsk())

const log = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<boolean> =>
  Effect.match(effect, { onFailure: () => false, onSuccess: () => true })

/**
 * Wraps the ask holder so every question and answer lands in the session log.
 * A question that cannot be recorded is still asked, but the log will show the
 * gap rather than a silent question.
 */
export const installAsk = (ask: AskShape, session: Session): AskShape => {
  let batchUsed = false
  // Only the wrapper that actually asked a batch records late answers; the
  // holder may be wrapped more than once for the same session.
  ask.onLateAnswer((answered) =>
    batchUsed ? log(session.append('interaction/ask/answers', answered)) : Effect.void,
  )
  return {
    ...ask,
    ask: (request) =>
      Effect.gen(function* () {
        yield* log(session.append('interaction/ask/requested', request))
        const answer = yield* ask.ask(request)
        yield* log(session.append('interaction/ask/answered', { id: request.id, answer }))
        return answer
      }),
    askBatch: (request, timeLimitMs) =>
      Effect.gen(function* () {
        batchUsed = true
        yield* log(session.append('interaction/ask/questions', request))
        const result = yield* ask.askBatch(request, timeLimitMs)
        if (result._tag === 'answered') {
          yield* log(
            session.append('interaction/ask/answers', {
              callId: request.callId,
              answers: result.answers,
            }),
          )
        } else {
          yield* log(
            session.append('interaction/ask/pending', {
              callId: result.callId,
              unanswered: result.unanswered,
            }),
          )
        }
        return result
      }),
  }
}
