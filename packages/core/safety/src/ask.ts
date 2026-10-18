import { Context, Data, Effect, Layer } from 'effect'
import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type Session,
  type SessionEventSchemaMap,
} from '@jozo-harness/session'
import { Schema } from 'effect'

/** A question for the user, with the choices the model offered. */
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
  }
}

const AskRequestedSchema = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
})

const AskAnsweredSchema = Schema.Struct({
  id: Schema.String,
  answer: Schema.String,
})

/** Schemas for the session events this module adds. */
export const askEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  ['interaction/ask/requested', AskRequestedSchema],
  ['interaction/ask/answered', AskAnsweredSchema],
])

registerSessionEventSchemas(askEventSchemas)
// A question and its answer are for the UI; the model sees neither.
registerLogOnlySessionEvents(['interaction/ask/requested', 'interaction/ask/answered'])

/** A question with nobody to answer it. The caller continues without the answer. */
export class AskUnavailable extends Data.TaggedError('AskUnavailable')<{
  readonly id: string
  readonly message: string
}> {}

/** Answers one question; the UI or a caller supplies it. */
export type AskAnswerer = (request: AskRequested) => Effect.Effect<string>

export interface AskShape {
  /**
   * Installs the answerer every later question goes to. While nobody is served a
   * question fails at once, because a seam with no answerer fails rather than
   * waits forever for one that will never come.
   */
  readonly serve: (answerer: AskAnswerer) => Effect.Effect<void>
  /** Says that nobody answers any more; later questions fail at once. */
  readonly stopServing: () => Effect.Effect<void>
  /** Whether somebody is there to answer. */
  readonly served: () => boolean
  /**
   * Asks one question and waits for its answer. Asking with nobody served is a
   * failure the model can read, not a hang.
   */
  readonly ask: (request: AskRequested) => Effect.Effect<string, AskUnavailable>
}

/** Answers live in memory only: a question is asked once and never replayed. */
export const makeAsk = (): Effect.Effect<AskShape> =>
  Effect.sync(() => {
    let answerer: AskAnswerer | undefined
    return {
      serve: (answer) =>
        Effect.sync(() => {
          answerer = answer
        }),
      stopServing: () =>
        Effect.sync(() => {
          answerer = undefined
        }),
      served: () => answerer !== undefined,
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
export const installAsk = (ask: AskShape, session: Session): AskShape => ({
  ...ask,
  ask: (request) =>
    Effect.gen(function* () {
      yield* log(session.append('interaction/ask/requested', request))
      const answer = yield* ask.ask(request)
      yield* log(session.append('interaction/ask/answered', { id: request.id, answer }))
      return answer
    }),
})
