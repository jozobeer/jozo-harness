import type { UiHost } from '@jozo-harness/ui-protocol'
import type { Schedule } from '@jozo-harness/tools-tier1'
import { Deferred, Effect, Exit, Scope } from 'effect'
import type { CommandView, JobDetailView, RunStateView, SessionSummary } from '../shared/rpc.ts'
import type { WebError } from './errors.ts'

/** One session the server can serve: the summary a page lists, and the UI face of its core. */
export interface OpenSession {
  readonly summary: SessionSummary
  readonly host: UiHost
  /** What the human can type at it, as the page's composer offers. */
  readonly commands: () => ReadonlyArray<CommandView>
  /** The goal and the schedules its log holds right now. */
  readonly runState: () => RunStateView
  /** What one background command has kept as output. */
  readonly jobOutput: (id: string) => Effect.Effect<JobDetailView, WebError>
  /** Stops one background command. */
  readonly stopJob: (id: string) => Effect.Effect<void, WebError>
  /** Stops one child agent this session started. */
  readonly stopSubagent: (id: string) => Effect.Effect<void, WebError>
  /** Whether the session still owns running work: a turn, a job, or a child agent. */
  readonly busy: () => boolean
  /** Hands one due schedule to the session it belongs to; false when it could not. */
  readonly deliver?: (schedule: Schedule) => Effect.Effect<boolean>
  /** Reads the schedules an older session log recorded into the host store. */
  readonly adoptSchedules?: () => void
}

/**
 * The session a server starts with, and how to release what the caller built it
 * in. The registry closes it like any other session when a page deletes it.
 */
export interface InitialSession {
  readonly session: OpenSession
  readonly close: () => Effect.Effect<void>
}

/** What the app that owns the profiles gives the server: the store's list, and one more session. */
export interface SessionFactory {
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, WebError>
  /** Opens the named session, or creates one in `cwd` when the id is absent. */
  readonly open: (
    id: string | undefined,
    cwd: string | undefined,
  ) => Effect.Effect<OpenSession, WebError, Scope.Scope>
}

/** The sessions one server serves: the one it started with, plus any the page asks for later. */
export interface SessionRegistry {
  /** The session a page opens when it names none; '' while the server holds none. */
  readonly initial: string
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, WebError>
  readonly open: (
    id: string | undefined,
    cwd: string | undefined,
  ) => Effect.Effect<OpenSession, WebError>
  /** Releases a session that is open; a no-op when nobody opened it. */
  readonly close: (id: string) => Effect.Effect<void>
  /** The host of a session already open; undefined when the page names one nobody opened. */
  readonly hostOf: (id: string) => UiHost | undefined
  /** What an open session says about itself; undefined when nobody opened it. */
  readonly stateOf: (id: string) => RunStateView | undefined
  /** What an open session can be told; undefined when nobody opened it. */
  readonly commandsOf: (id: string) => ReadonlyArray<CommandView> | undefined
  /** The open session with this id; undefined when nobody opened it. */
  readonly sessionOf: (id: string) => OpenSession | undefined
  /** Every session open right now, the boot session first. */
  readonly openedIds: () => ReadonlyArray<string>
}

/** One session the registry holds, with the way to release what it runs in. */
interface OpenEntry {
  readonly session: OpenSession
  readonly close: () => Effect.Effect<void>
}

/**
 * Keeps one running core per session. A session opens the first time a page asks
 * for it and stays open until the page deletes it or the server stops, so
 * switching back is free. A server may start with none: the first session is
 * the one a page asks for.
 */
export const makeSessionRegistry = (input: {
  readonly initial?: InitialSession
  readonly factory: SessionFactory
}): Effect.Effect<SessionRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const opened = new Map<string, OpenEntry>(
      input.initial === undefined ? [] : [[input.initial.session.summary.id, input.initial]],
    )
    // A session whose core is still being built. The map is filled before the
    // build yields, so a second page cannot pass the lookup and start another.
    const inflight = new Map<string, Deferred.Deferred<OpenSession, WebError>>()
    let initialId = input.initial?.session.summary.id ?? ''
    // The scope this registry lives in: every session it opens is closed with it.
    const own = yield* Scope.Scope

    /** Builds one core and remembers it. The server's scope closes the core when it stops. */
    const build = (
      id: string | undefined,
      cwd: string | undefined,
    ): Effect.Effect<OpenSession, WebError, Scope.Scope> =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const session = yield* input.factory
          .open(id, cwd)
          .pipe(Effect.provideService(Scope.Scope, scope))
        opened.set(session.summary.id, {
          session,
          close: () => Scope.close(scope, Exit.void),
        })
        return session
      })

    /**
     * Forgets this build before waking the pages waiting on it. A page that
     * retries from the wake must not find the old gate, and a failed build must
     * not leave one that never starts another core.
     */
    const settle = (
      id: string,
      gate: Deferred.Deferred<OpenSession, WebError>,
      exit: Exit.Exit<OpenSession, WebError>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        inflight.delete(id)
        if (Exit.isSuccess(exit)) {
          yield* Deferred.succeed(gate, exit.value)
          return
        }
        yield* Deferred.failCause(gate, exit.cause)
      })

    /**
     * Starts one build and lets later pages wait on its gate. The claim happens
     * before the build yields, so two opens of one id cannot both pass the lookup.
     */
    const openOnce = (
      id: string | undefined,
      cwd: string | undefined,
    ): Effect.Effect<OpenSession, WebError, Scope.Scope> => {
      if (id === undefined) return build(id, cwd)
      const gate = Deferred.makeUnsafe<OpenSession, WebError>()
      inflight.set(id, gate)
      return build(id, cwd).pipe(Effect.onExit((exit) => settle(id, gate, exit)))
    }

    const openInOwnScope = (
      id: string | undefined,
      cwd: string | undefined,
    ): Effect.Effect<OpenSession, WebError> =>
      Effect.gen(function* () {
        if (id !== undefined) {
          const known = opened.get(id)
          if (known !== undefined) return known.session
          const pending = inflight.get(id)
          if (pending !== undefined) return yield* Deferred.await(pending)
        }
        return yield* openOnce(id, cwd)
      }).pipe(Effect.provideService(Scope.Scope, own))

    const close = (id: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = opened.get(id)
        if (entry === undefined) return Effect.void
        // The scope goes first and the entry second: a page that asks while the
        // core is closing still finds it, and the next request never does.
        return entry.close().pipe(
          Effect.ensuring(
            Effect.sync(() => {
              opened.delete(id)
              if (initialId === id) initialId = ''
            }),
          ),
        )
      })

    return {
      // '' when the server holds none yet, or once the page deleted the boot one.
      get initial() {
        return initialId
      },
      list: input.factory.list,
      open: openInOwnScope,
      close,
      hostOf: (id) => opened.get(id)?.session.host,
      stateOf: (id) => opened.get(id)?.session.runState(),
      commandsOf: (id) => opened.get(id)?.session.commands(),
      sessionOf: (id) => opened.get(id)?.session,
      openedIds: () => [...opened.keys()],
    }
  })
