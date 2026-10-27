import { Effect, Semaphore } from 'effect'
import type { RequestMessage } from '@jozo-harness/llm'
import { deriveMessages } from './derive.ts'
import type { MessageProjection } from './projections.ts'
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
            if (options.notify !== undefined) {
              yield* options
                .notify(event)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError('session/event observer failed', { cause }),
                  ),
                )
            }
          }),
        )
      })

    return {
      id: options.id,
      header: first.data,
      events: () => [...log],
      append,
      flush: options.sink.flush,
      derive: (projections?: ReadonlyArray<MessageProjection>) => deriveMessages(log, projections),
    }
  })
}
