import type { UiHost } from '@jozo-harness/ui-protocol'
import { Effect, Exit, Scope } from 'effect'
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

/**
 * Keeps one running core per session. A session opens the first time a page asks
 * for it and stays open until the server stops, so switching back is free. A
 * server may start with none: the first session is the one a page asks for.
 */
export const makeSessionRegistry = (input: {
  readonly initial?: OpenSession
  readonly factory: SessionFactory
}): Effect.Effect<SessionRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const opened = new Map<string, OpenSession>(
      input.initial === undefined ? [] : [[input.initial.summary.id, input.initial]],
    )
    // The scope this registry lives in: every session it opens is closed with it.
    const own = yield* Scope.Scope

    const openInOwnScope = (
      id: string | undefined,
      cwd: string | undefined,
    ): Effect.Effect<OpenSession, WebError> =>
      Effect.gen(function* () {
        const known = id === undefined ? undefined : opened.get(id)
        if (known !== undefined) return known
        // One scope per session: the server's own scope closes it when the server stops.
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const session = yield* input.factory
          .open(id, cwd)
          .pipe(Effect.provideService(Scope.Scope, scope))
        opened.set(session.summary.id, session)
        return session
      }).pipe(Effect.provideService(Scope.Scope, own))

    return {
      // '' when the server holds none yet: a page then starts one itself.
      initial: input.initial?.summary.id ?? '',
      list: input.factory.list,
      open: openInOwnScope,
      hostOf: (id) => opened.get(id)?.host,
      stateOf: (id) => opened.get(id)?.runState(),
      commandsOf: (id) => opened.get(id)?.commands(),
      sessionOf: (id) => opened.get(id),
      openedIds: () => [...opened.keys()],
    }
  })
