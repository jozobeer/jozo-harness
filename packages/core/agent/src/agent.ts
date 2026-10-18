import { Deferred, Effect, Fiber, Queue, Scope } from 'effect'
import type { Session, SessionError, SessionId } from '@jozo-harness/session'
import { makeInbox } from './inbox.ts'
import type { UserMessage } from './events.ts'
import type { Agent, AgentCancelCause, AgentDriver, AgentOptions, AgentStatus } from './types.ts'

/** Mutable slot the registry fills with the running fiber, and with how to start another. */
export interface AgentHandle {
  fiber: Fiber.Fiber<void, never> | undefined
  /** Forks a runner into the agent's scope and keeps its fiber here. */
  start: Effect.Effect<void>
}

export interface MakeAgentOptions {
  readonly id: SessionId
  readonly session: Session
  readonly options: AgentOptions
  readonly scope: Scope.Scope
  readonly handle: AgentHandle
}

/**
 * The options as they are with this effort. `''` drops the field, so the
 * provider chooses; an effort that is already absent keeps the same object.
 */
const withEffort = (options: AgentOptions, effort: string): AgentOptions => {
  const { reasoningEffort: before, ...rest } = options
  if (effort !== '') return { ...rest, reasoningEffort: effort }
  return before === undefined ? options : rest
}

/** The options as they are with this route; the route already asked keeps the same object. */
const withRoute = (options: AgentOptions, route: string): AgentOptions =>
  options.route === route ? options : { ...options, route }

/**
 * Builds the agent shell: durable inbox, status, cancellation, and the
 * `whenIdle` wait. Turn execution is the runner's job.
 */
export function makeAgent(input: MakeAgentOptions): Effect.Effect<Agent> {
  return Effect.gen(function* () {
    const inbox = makeInbox(input.session)
    const wake = yield* Queue.unbounded<void>()
    const waiters = new Set<Deferred.Deferred<void>>()
    let status: AgentStatus = 'idle'
    let cancelCause: AgentCancelCause | undefined = undefined

    const settled = (): boolean => status === 'disposed' || (status === 'idle' && !inbox.pending)

    // Snapshot before completing: a resumed waiter may register a new waiter
    // while this loop is still running.
    const notify = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pending = [...waiters]
        waiters.clear()
        for (const waiter of pending) yield* Deferred.succeed(waiter, void 0)
      })

    const setStatus = (next: AgentStatus): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (status !== 'disposed' || next === 'disposed') status = next
        yield* notify()
      })

    const driver: AgentDriver = {
      setStatus,
      get cancelCause() {
        return cancelCause
      },
      wake,
    }

    const whenIdle = Effect.suspend(() =>
      Effect.gen(function* () {
        while (!settled()) {
          const waiter = yield* Deferred.make<void>()
          waiters.add(waiter)
          if (settled()) {
            waiters.delete(waiter)
            return
          }
          yield* Deferred.await(waiter)
        }
      }),
    )

    /**
     * Queued input always wakes the runner: a steer or inject that lands as a turn
     * closes has no step left to be claimed at, and nothing else would open the
     * turn it waits for. A wake the running turn already answered costs one loop.
     */
    const queue = (
      target: 'next-turn' | 'next-step',
      message: UserMessage,
    ): Effect.Effect<void, SessionError> =>
      Effect.gen(function* () {
        yield* inbox.queue(target, message)
        yield* notify()
        yield* Queue.offer(wake, void 0)
      })

    // A human may switch the effort or the model while the session runs, so the
    // options are read through this rather than handed out once: the runner takes
    // them per request, and the switch lands on the request after it.
    let current = input.options

    return {
      id: input.id,
      session: input.session,
      get options() {
        return current
      },
      inbox,
      scope: input.scope,
      driver,
      get status() {
        return status
      },
      setEffort: (next) =>
        Effect.sync(() => {
          current = withEffort(current, next)
        }),
      setRoute: (next) =>
        Effect.sync(() => {
          current = withRoute(current, next)
        }),
      followup: (message) => queue('next-turn', message),
      steer: (message) => queue('next-step', message),
      inject: (message) => queue('next-step', message),
      cancel: (cause) =>
        Effect.gen(function* () {
          if (status === 'disposed') return
          cancelCause = cause
          if (input.handle.fiber === undefined) return
          yield* setStatus('cancelling')
          // The interrupt waits for the turn's finalizer, which records this cause.
          yield* Fiber.interrupt(input.handle.fiber)
          cancelCause = undefined
          // Input no turn took goes with the cancelled work, so nothing waits on a runner
          // that is gone; a failed append is no reason to leave the agent without one.
          yield* inbox.drop().pipe(Effect.catchCause(() => Effect.void))
          yield* input.handle.start
          yield* setStatus('idle')
        }),
      whenIdle,
    }
  })
}
