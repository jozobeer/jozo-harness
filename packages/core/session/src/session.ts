import { Effect, Semaphore } from 'effect'
import type { RequestMessage } from '@jozo-harness/llm'
import {
  continueMessagesWithSeqs,
  deriveMessages,
  deriveMessagesWithSeqs,
  type DerivedMessage,
} from './derive.ts'
import type { MessageProjection } from './projections.ts'
import type { ProjectionCheckpoint } from './projection-checkpoint.ts'
import { resumeProjection } from './projection-checkpoint.ts'
import { SessionError } from './errors.ts'
import type { SessionEvent, SessionEventMap, SessionHeader, SessionId } from './events.ts'
import { isJsonValue } from './json.ts'
import type { SessionSink } from './persistence.ts'

export interface AppendOptions {
  readonly ignorable?: true
}

/** One live, append-only session log. */
export interface Session {
  readonly id: SessionId
  readonly header: SessionHeader
  /** Snapshot of the log so far. */
  events(): ReadonlyArray<SessionEvent>
  append<K extends keyof SessionEventMap>(
    type: K,
    data: SessionEventMap[K],
    options?: AppendOptions,
  ): Effect.Effect<void, SessionError>
  flush(): Effect.Effect<void, SessionError>
  derive(projections?: ReadonlyArray<MessageProjection>): ReadonlyArray<RequestMessage>
}

export interface MakeSessionOptions {
  readonly id: SessionId
  /** The restored log. Must start with `session/header`. */
  readonly events: ReadonlyArray<SessionEvent>
  readonly sink: SessionSink
  readonly now?: () => number
  readonly notify?: (event: SessionEvent) => Effect.Effect<void, unknown>
}

/** A checkpoint is due after this many appended events, or this much time. */
const CHECKPOINT_EVENTS = 200
const CHECKPOINT_INTERVAL_MS = 5_000

/** The fold's state as of the last checkpoint. */
interface FoldBase {
  readonly seq: number
  readonly derived: ReadonlyArray<DerivedMessage>
}

/** Builds a session over a restored log and its sink. */
export function makeSession(options: MakeSessionOptions): Effect.Effect<Session, SessionError> {
  return Effect.gen(function* () {
    const first = options.events[0]
    if (first === undefined || first.type !== 'session/header') {
      return yield* Effect.fail(
        new SessionError({
          code: 'persistence',
          message: 'a session log must start with session/header',
        }),
      )
    }
    const log: Array<SessionEvent> = [...options.events]
    const now = options.now ?? Date.now
    // A restored log can omit an ignorable line, so the next seq is one past the
    // highest that was stored. Counting the events still in memory would reuse a
    // seq the page has already applied, and that page drops anything not newer.
    let highest = 0
    for (const stored of log) if (stored.seq > highest) highest = stored.seq
    // A follow-up or a skill load appends while the runner is still writing the
    // previous line. The seq is chosen and published under this permit, so the
    // two writers cannot share one. The observer runs inside the permit and must
    // not append to this session, or it would wait for a permit it already holds.
    const writes = Semaphore.makeUnsafe(1)
    const saveProjection = options.sink.saveProjection
    const loadProjection = options.sink.loadProjection

    // The fold's state as of the loaded checkpoint, kept in step with appends so
    // saving is a serialisation rather than another pass over the log.
    let base: FoldBase | undefined
    let sinceWrite = 0
    let lastWriteAt = now()

    if (loadProjection !== undefined && saveProjection !== undefined) {
      const stored = yield* loadProjection().pipe(
        Effect.catchCause(() => Effect.succeed<ProjectionCheckpoint | undefined>(undefined)),
      )
      if (stored !== undefined) {
        try {
          const resumed = resumeProjection(log, stored)
          if (resumed.resumed) base = { seq: stored.seq, derived: resumed.derived }
        } catch {
          // A tail this process cannot project is not a reason to refuse the open;
          // derive() reports it the way a full fold always has.
          base = undefined
        }
      }
    }

    const saveCheckpoint = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (saveProjection === undefined) return
        if (base === undefined) {
          // Without a state to serialize, the first save pays for one fold of the
          // log; later saves fold only what was appended since.
          try {
            base = { seq: highest, derived: deriveMessagesWithSeqs(log) }
          } catch {
            base = undefined
          }
        }
        const state = base
        // Count the attempt even when the fold failed, so an event whose plugin
        // is missing does not make every later append retry the whole log.
        sinceWrite = 0
        lastWriteAt = now()
        if (state === undefined) return
        // A cache that cannot be written must not fail an append or a close.
        yield* saveProjection(state.seq, state.derived).pipe(Effect.ignore)
      })

    const checkpointDue = (): boolean =>
      saveProjection !== undefined &&
      (sinceWrite >= CHECKPOINT_EVENTS || now() - lastWriteAt >= CHECKPOINT_INTERVAL_MS)

    /** Folds one appended event into the checkpoint state, or gives the state up. */
    const advance = (event: SessionEvent): void => {
      if (saveProjection === undefined) return
      sinceWrite += 1
      if (base === undefined) return
      try {
        base = { seq: event.seq, derived: continueMessagesWithSeqs([event], base.derived) }
      } catch {
        // An event whose plugin is not loaded cannot be folded here; leave the
        // checkpoint alone until a save or a derive() rebuilds it from the log.
        base = undefined
      }
    }

    const append = <K extends keyof SessionEventMap>(
      type: K,
      data: SessionEventMap[K],
      appendOptions?: AppendOptions,
    ): Effect.Effect<void, SessionError> =>
      Effect.gen(function* () {
        if (!isJsonValue(data)) {
          return yield* Effect.fail(
            new SessionError({
              code: 'not-serializable',
              message: `${String(type)} data cannot be stored as JSON`,
            }),
          )
        }
        yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const event = {
              seq: highest + 1,
              time: now(),
              type,
              data,
              ...(appendOptions?.ignorable === true ? { ignorable: true as const } : {}),
            } as SessionEvent
            yield* options.sink.append(event)
            highest = event.seq
            log.push(event)
            advance(event)
            if (options.notify !== undefined) {
              yield* options
                .notify(event)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError('session/event observer failed', { cause }),
                  ),
                )
            }
            if (checkpointDue()) yield* saveCheckpoint()
          }),
        )
      })

    return {
      id: options.id,
      header: first.data,
      events: () => [...log],
      append,
      flush: () =>
        Effect.gen(function* () {
          yield* options.sink.flush()
          // The close still leaves a checkpoint for the next open, even if no
          // derive() ran during this process.
          yield* saveCheckpoint()
        }),
      derive: (projections?: ReadonlyArray<MessageProjection>) => {
        const usesRegistered = projections === undefined || projections.length === 0
        if (!usesRegistered) return deriveMessages(log, projections)
        if (base !== undefined) return base.derived.map((entry) => entry.message)
        const derived = deriveMessagesWithSeqs(log)
        if (saveProjection !== undefined) base = { seq: highest, derived }
        return derived.map((entry) => entry.message)
      },
    }
  })
}
