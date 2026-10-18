import { Cause, Effect, Fiber, Queue, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import type { UiCommand, UiEvent } from '@jozo-harness/ui-protocol'
import { batch, createSignal, type Accessor } from 'solid-js'
import {
  UiRpcs,
  withoutServices,
  type DirectoryView,
  type JobDetailView,
  type RunStateView,
  type SessionAction,
} from '../src/shared/rpc.ts'
import {
  applyUiEvent,
  initialState,
  withBlank,
  withBranch,
  withCommands,
  withConnection,
  withDraft,
  withFiles,
  withModels,
  withOpened,
  withPane,
  withProblem,
  withRun,
  withSession,
  withSessions,
  withSettings,
  withTheme,
  withWorkspaces,
  type Pane,
  type WebState,
} from '../src/ui/state.ts'
import type { Theme } from '../src/ui/theme.ts'
import { draftOnMove, drafted } from '../src/ui/draft.ts'
import { readDraft, writeDraft } from './drafts.ts'
import {
  addressSession,
  keptTheme,
  keepTheme,
  onNextFrame,
  pageSearch,
  pageSocket,
  showTheme,
} from './dom.ts'
import { emptyWatched, watchedAfter, type Watched } from '../src/ui/board.ts'
import { makeBridge } from './bridge.ts'

/** How one failed call reads in the status strip. */
const messageOf = (error: unknown): string =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)

/** The one line a whole cause reads as, defects included. */
const causeText = (cause: Cause.Cause<unknown>): string => messageOf(Cause.squash(cause))

/** How long one keystroke waits before the draft is written for the next visit. */
const DRAFT_SAVE_DELAY = 300

/** How long a pipeline the page cannot lose waits before it runs again. */
const RESTART_DELAY = '250 millis'

/** A cause that is only an interruption is the page moving on, not a failure. */
const unlessInterrupted = (
  cause: Cause.Cause<unknown>,
  onFailure: Effect.Effect<void>,
): Effect.Effect<void> => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : onFailure)

/**
 * Runs one pipeline that must outlive a failure: it is reported and started
 * again. A subscription the page dropped otherwise takes the page down with it
 * in silence, which reads as input that does nothing.
 */
const keepsRunning = <A>(
  what: string,
  effect: Effect.Effect<A, unknown, unknown>,
  report: (message: string) => void,
): Effect.Effect<never, never, unknown> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      unlessInterrupted(
        cause,
        Effect.sync(() => report(what + ': ' + causeText(cause))),
      ),
    ),
    Effect.andThen(Effect.sleep(RESTART_DELAY)),
    Effect.forever,
  )

/**
 * How the page checks the socket is still there. Effect's own timeout equals its
 * interval, so a tick that lands a hair late — a throttled timer, a page busy
 * with a long answer — writes the whole connection off, and an idle session
 * reads as a feed that keeps dropping. A page sits quiet for minutes at a time,
 * so the check is cheap and the verdict is slow: a ping every twenty seconds,
 * and a minute of silence before the socket is given up on.
 */
const KEEP_ALIVE = { pingInterval: '20 seconds', pingTimeout: '1 minute' } as const

/** How often a running turn or job reads the run state again: work comes and goes inside one. */
const RUN_BEAT = '1 second'

/** True while a job the page knows still runs, so the pane keeps up with it after its turn ends. */
const jobRuns = (run: RunStateView | undefined): boolean =>
  run?.jobs.some((job) => job.running) === true

/** The pane when it is one job's, narrowed to it; undefined otherwise. */
const jobPaneOf = (pane: Pane | undefined): Extract<Pane, { kind: 'job' }> | undefined =>
  pane?.kind === 'job' ? pane : undefined

/** True when the beat has work to read: a turn, a job, or the output of an open running job. */
const workRunning = (
  current: WebState,
  openJob: Extract<Pane, { kind: 'job' }> | undefined,
): boolean =>
  current.conversation.running || jobRuns(current.run) || openJob?.detail?.running === true

/** The run state lands only on the session it was read for, not one the reader moved to. */
const runIfSame = (now: WebState, sessionId: string, run: RunStateView): WebState =>
  now.sessionId === sessionId ? withRun(now, run) : now

/** A job's output lands only on its own pane in the session it was read for. */
const detailIfOpen = (
  now: WebState,
  sessionId: string,
  id: string,
  detail: JobDetailView,
): WebState => {
  const pane = jobPaneOf(now.pane)
  return now.sessionId === sessionId && pane?.id === id
    ? withPane(now, { kind: 'job', id, detail })
    : now
}

/** What one session's log told the page to read again. */
const needsRefresh = (type: string): boolean =>
  type === 'turn/end' || type === 'goal/updated' || type.startsWith('agent/inbox/')

const sessionInUrl = (search: string): string | undefined => {
  const value = new URLSearchParams(search).get('session')
  return value === null || value === '' ? undefined : value
}

/** The session a page opens on its own: what the address names, or the one the server holds. */
const sessionToOpen = (current: string, search: string, held: string): string | undefined => {
  if (current !== '') return current
  const named = sessionInUrl(search)
  if (named !== undefined) return named
  return held === '' ? undefined : held
}

/** What a move in the queue asks of the page: read a session, or stand on a blank one. */
type Move =
  | { readonly kind: 'open'; readonly id: string | undefined; readonly cwd?: string | undefined }
  | { readonly kind: 'blank' }

/** What the workspace picker asked of the server: the list, a folder to browse, or one to add. */
type WorkspaceAsk =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'browse'
      readonly path: string
      readonly reply: (answer: BrowseAnswer) => void
    }
  | { readonly kind: 'add'; readonly cwd: string }

/** What the Add workspace dialog heard about one folder. */
export type BrowseAnswer =
  | { readonly kind: 'listed'; readonly view: DirectoryView }
  | { readonly kind: 'refused'; readonly message: string }

/** What the settings pane asked the server for. */
type PanelAsk =
  | { readonly kind: 'models' }
  | { readonly kind: 'commands'; readonly sessionId: string }
  | { readonly kind: 'files'; readonly sessionId: string; readonly query: string }
  | { readonly kind: 'chooseModel'; readonly model: string }
  | { readonly kind: 'setModel'; readonly model: string }
  | { readonly kind: 'job'; readonly id: string }
  | { readonly kind: 'stopJob'; readonly id: string }
  | { readonly kind: 'stopSubagent'; readonly id: string }
  | { readonly kind: 'sessionAction'; readonly sessionId: string; readonly action: SessionAction }

/** Everything the components may ask of the session. */
export interface SessionStore {
  readonly state: Accessor<WebState>
  /** Every session the server has open, followed live, by id. */
  readonly watched: Accessor<ReadonlyMap<string, Watched>>
  /** Opens the socket and reads the store; call once, when the app mounts. */
  readonly start: () => void
  /** Stops the program, for a page that is going away. */
  readonly stop: () => void
  readonly setDraft: (text: string) => void
  readonly submit: () => void
  readonly send: (command: UiCommand) => void
  /** Sends one command to a session that need not be the one on screen. */
  readonly sendTo: (sessionId: string, command: UiCommand) => void
  /**
   * Reads a session, or stands on the blank page the first line fills when
   * undefined. A blank page starts its session in `cwd` when one is named.
   */
  readonly moveTo: (id: string | undefined, cwd?: string) => void
  readonly chooseTheme: (theme: Theme) => void
  readonly showPane: (pane: Pane | undefined) => void
  readonly openJob: (id: string) => void
  readonly stopJob: (id: string) => void
  /** Stops one child agent the session on screen started. */
  readonly stopSubagent: (id: string) => void
  readonly askModels: () => void
  /** Reads what the session on screen can be told, the first time the composer offers it. */
  readonly askCommands: () => void
  /** Reads the workspace paths an @word names, once the composer has waited for the typing to stop. */
  readonly askFiles: (query: string) => void
  /** Reads the folders a new session may start in. */
  readonly askWorkspaces: () => void
  /**
   * Reads one folder for the Add workspace dialog; the folders inside it, or
   * why they could not be read, go to `reply`. A blank path starts at the run's
   * own folder.
   */
  readonly browseDirectories: (path: string, reply: (answer: BrowseAnswer) => void) => void
  /** Registers one more folder a new session may start in, and reads the list again. */
  readonly addWorkspace: (cwd: string) => void
  /**
   * Picks the route for this session and for the sessions opened from now on.
   * Nothing is written down, so the runs after this one keep their own choice.
   */
  readonly chooseModel: (model: string) => void
  /** Picks the route the settings file keeps for the runs after this one. */
  readonly setModel: (model: string) => void
  /** Renames, pins, archives, or deletes one session through its row menu. */
  readonly act: (sessionId: string, action: SessionAction) => void
}

export interface SessionStoreOptions {
  /** Where the socket lives; the page's own origin when absent. */
  readonly url?: string
  /** The search string the session in the address bar is read from. */
  readonly search?: string
}

export const createSessionStore = (options: SessionStoreOptions = {}): SessionStore => {
  const url = options.url ?? pageSocket()
  const search = options.search ?? pageSearch()
  const [state, setState] = createSignal<WebState>(initialState)
  const update = (next: (current: WebState) => WebState): void => {
    setState((current) => next(current))
  }

  const [watched, setWatched] = createSignal<ReadonlyMap<string, Watched>>(new Map())

  /**
   * Each session's own line, and the one the blank page holds for the first
   * session it opens. The composer shows one at a time; a move swaps which.
   */
  let drafts: ReadonlyMap<string, string> = new Map()
  /** Lines typed but not yet written, and the one timer that writes them. */
  const pendingDrafts = new Map<string, string>()
  let savingDrafts: ReturnType<typeof setTimeout> | undefined

  /** Writes every pending line, so a reload a moment later reads it back. */
  const flushDrafts = (): void => {
    if (savingDrafts !== undefined) clearTimeout(savingDrafts)
    savingDrafts = undefined
    for (const [sessionId, text] of pendingDrafts) writeDraft(sessionId, text)
    pendingDrafts.clear()
  }

  /** Remembers one session's line here, and a moment later for the next visit. */
  const rememberDraft = (sessionId: string, text: string): void => {
    drafts = drafted(drafts, sessionId, text)
    pendingDrafts.set(sessionId, text)
    if (savingDrafts === undefined) savingDrafts = setTimeout(flushDrafts, DRAFT_SAVE_DELAY)
  }

  /** The line one session already holds: this visit's first, or the one storage kept. */
  const draftOf = (sessionId: string): string =>
    drafts.has(sessionId) ? (drafts.get(sessionId) ?? '') : readDraft(sessionId)

  /** Empties the composer and forgets the line once it has been sent. */
  const clearDraft = (sessionId: string): void => {
    rememberDraft(sessionId, '')
    update((now) => withDraft(now, ''))
  }

  /**
   * What has arrived but is not yet what the view reads. One session's history
   * arrives as hundreds of events at once, and a signal written per event draws
   * the whole conversation again for each of them: seconds of blocked main thread
   * for a log the fold itself reads in milliseconds. Everything that arrived is
   * folded once instead, before the page is painted next.
   */
  const arrived: Array<{
    readonly sessionId: string
    readonly event: UiEvent
    /** The line the feed had put in the strip when this event arrived, which this event answers for. */
    readonly clears: string
  }> = []
  const watchedArrived: Array<{ readonly id: string; readonly event: UiEvent }> = []

  /**
   * How many events the page folds without waiting for a frame. A page nothing
   * paints asks for no frame, so this keeps what it holds from growing without
   * bound while it is not being looked at.
   */
  const FOLD_AT_ONCE = 512

  let waiting = false

  /** Folds everything that arrived into one write per signal, in the order it arrived. */
  const fold = (): void => {
    waiting = false
    const events = arrived.splice(0, arrived.length)
    const seen = watchedArrived.splice(0, watchedArrived.length)
    // One write to each signal, in one pass: the page is drawn once for the batch.
    batch(() => {
      if (events.length > 0) {
        setState((now) =>
          events
            // A feed that follows a session again replays the log it follows, so an
            // event of a session the page has since left has nowhere to land.
            .filter((one) => one.sessionId === now.sessionId)
            .reduce((current, one) => {
              // A feed that reached the page again is working: it takes its own line
              // back, and leaves anything else the reader was told.
              const cleared =
                one.clears !== '' && current.problem === one.clears
                  ? withProblem(current, '')
                  : current
              return applyUiEvent(cleared, one.event)
            }, now),
        )
      }
      if (seen.length > 0) {
        setWatched((now) => {
          const next = new Map(now)
          for (const one of seen) {
            next.set(one.id, watchedAfter(next.get(one.id) ?? emptyWatched, one.event))
          }
          return next
        })
      }
    })
  }

  /** Folds now when the page is far behind, and otherwise once before the next paint. */
  const scheduleFold = (): void => {
    if (arrived.length + watchedArrived.length >= FOLD_AT_ONCE) {
      fold()
      return
    }
    if (waiting) return
    waiting = true
    onNextFrame(fold)
  }
  /**
   * The message typed before any session existed. The session it starts is
   * opened for it, and it is sent there; a session that cannot be opened gives
   * the line back to the composer rather than swallowing it.
   */
  let owed: string | undefined
  /** The folder the blank page will start its session in; the last one the reader picked. */
  let blankCwd: string | undefined
  const commands = Effect.runSync(
    Queue.unbounded<{ readonly sessionId: string; readonly command: UiCommand }>(),
  )
  const moves = Effect.runSync(Queue.unbounded<Move>())
  const panelAsks = Effect.runSync(Queue.unbounded<PanelAsk>())
  const workspaceAsks = Effect.runSync(Queue.unbounded<WorkspaceAsk>())
  let following: Fiber.Fiber<void, unknown> | undefined
  const bridge = makeBridge((message) => update((current) => withProblem(current, message)))

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(UiRpcs)
    /** The sessions this connection follows for the board; a dropped stream may follow again. */
    const watching = new Set<string>()

    const watch = (id: string) =>
      Effect.suspend(() => {
        if (watching.has(id)) return Effect.void
        watching.add(id)
        return Effect.forkScoped(
          client.events({ sessionId: id }).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                watchedArrived.push({ id, event })
                scheduleFold()
              }),
            ),
            // A row that stops moving is not worth the reader's attention: the
            // board follows the session again without saying anything about it.
            Effect.catchCause((cause) => unlessInterrupted(cause, Effect.void)),
            Effect.andThen(Effect.sleep(RESTART_DELAY)),
            Effect.forever,
            // The claim on the id stands for the whole life of this fiber, so a
            // second look at the same session does not open a second stream.
            Effect.ensuring(Effect.sync(() => watching.delete(id))),
          ),
        ).pipe(Effect.asVoid)
      })

    // The orchestration below mirrors the current page's while both entries are
    // served side by side: the port is compared against it, so the two are not
    // refactored apart. The markers lift the duplication gate for this range.
    /* jscpd:ignore-start */
    // Reads the store and the run state again: a session earns its name as it works.
    const relist = () =>
      Effect.gen(function* () {
        const listed = yield* client.sessions()
        const current = state()
        const running =
          current.sessionId === ''
            ? undefined
            : yield* client.state({ sessionId: current.sessionId })
        yield* Effect.sync(() => {
          update((now) => withSessions(now, listed.items))
          update((now) => withOpened(now, listed.opened))
          if (running !== undefined) update((now) => withRun(now, running))
        })
        yield* Effect.forEach(listed.opened, watch)
      })

    /**
     * The asks to read the store again, and the fiber that answers them. A feed
     * hands the ask over instead of making the calls itself: a client stops
     * reading its socket while a feed's buffer holds events, so a feed that waits
     * on a call of its own waits for an answer that arrives behind the very
     * events it is holding up. Only the newest ask matters — a reader wants the
     * store as it is now, not once per event that changed it.
     */
    const refreshes = Effect.runSync(Queue.sliding<void>(1))
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(refreshes), () =>
        relist().pipe(
          Effect.catchCause((cause) =>
            unlessInterrupted(
              cause,
              Effect.sync(() => update((now) => withProblem(now, causeText(cause)))),
            ),
          ),
        ),
      ),
    )

    /**
     * A turn is not the only thing that changes the Run pane: a job or a child
     * agent starts and finishes inside one, and a job can outlive the turn that
     * started it. While a turn or a job runs, the run state is read on a slow
     * beat; an open job's output is read with it, so its pane keeps growing.
     */
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* Effect.sleep(RUN_BEAT)
        const current = state()
        if (current.sessionId === '') return
        const sessionId = current.sessionId
        const openJob = jobPaneOf(current.pane)
        if (!workRunning(current, openJob)) return
        yield* client.state({ sessionId }).pipe(
          Effect.tap((run) => Effect.sync(() => update((now) => runIfSame(now, sessionId, run)))),
          // A failed beat is the next one's problem; the page still has its last view.
          Effect.catchCause(() => Effect.void),
        )
        if (openJob?.detail?.running !== true) return
        yield* client.jobDetail({ sessionId, id: openJob.id }).pipe(
          Effect.tap((detail) =>
            Effect.sync(() => update((now) => detailIfOpen(now, sessionId, openJob.id, detail))),
          ),
          Effect.catchCause(() => Effect.void),
        )
      }).pipe(Effect.forever),
    )

    /**
     * Everything one session logs, until the page moves on. A dropped
     * subscription follows again: the server opens with the session's history,
     * and the fold keeps only the events past the last one it applied, so the
     * turns the page missed arrive on the second look.
     */
    const follow = (id: string) => {
      /** The line this feed last put in the strip, so only its own report clears. */
      let reported = ''
      return keepsRunning(
        'the session feed',
        client.events({ sessionId: id }).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                // The event waits for the frame with everything else that arrived,
                // so the log costs one drawing instead of one per event.
                arrived.push({ sessionId: id, event, clears: reported })
                scheduleFold()
              })
              // Handed over rather than awaited: the feed has to keep draining.
              if (event.kind === 'session' && needsRefresh(event.event.type)) {
                yield* Queue.offer(refreshes, undefined)
              }
            }),
          ),
        ),
        (message) => {
          reported = message
          update((now) => withProblem(now, message))
        },
      )
    }

    /** The line typed before any session opened is the first thing this one hears. */
    const sendOwed = (sessionId: string): Effect.Effect<void> => {
      const first = owed
      if (first === undefined) return Effect.void
      owed = undefined
      return Effect.asVoid(
        Queue.offer(commands, { sessionId, command: { kind: 'submit', text: first } }),
      )
    }

    const show = (id: string | undefined, cwd?: string) =>
      Effect.gen(function* () {
        const summary = yield* client.open(
          id === undefined ? (cwd === undefined ? {} : { cwd }) : { sessionId: id },
        )
        if (following !== undefined) yield* Fiber.interrupt(following)
        // The branch is a second read of the same workspace; asking for both at
        // once keeps opening a session as quick as it was without one.
        const [running, branch] = yield* Effect.all([
          client.state({ sessionId: summary.id }),
          // A workspace the server cannot place keeps the strip to the path alone.
          client.branch({ sessionId: summary.id }).pipe(Effect.catch(() => Effect.succeed(null))),
        ])
        // The session being left keeps its line; the one being opened shows its
        // own, and a line typed on the blank page belongs to the first it opens.
        const moved = draftOnMove(drafts, state().sessionId, summary.id, draftOf(summary.id))
        drafts = moved.drafts
        yield* Effect.sync(() => {
          update((now) =>
            withDraft(
              withRun(withBranch(withSession(now, summary), branch ?? ''), running),
              moved.text,
            ),
          )
          addressSession(summary.id)
        })
        following = yield* Effect.forkScoped(follow(summary.id))
        yield* watch(summary.id)
        yield* sendOwed(summary.id)
      })
    /* jscpd:ignore-end */

    /**
     * Stands on the blank page without asking the server for anything. The feed
     * of the session left behind stops, and its events no longer land; the first
     * line typed here opens the session that receives it.
     */
    const standOnBlank = () =>
      Effect.gen(function* () {
        if (following !== undefined) yield* Fiber.interrupt(following)
        following = undefined
        const text = draftOf('')
        yield* Effect.sync(() => {
          update((now) => withDraft(withBlank(now), text))
          addressSession(undefined)
        })
      })

    yield* Effect.sync(() => {
      update((now) => withConnection(now, true))
    })

    /**
     * What one command the core never took means for the reader: the line is said
     * out loud, and the draft comes back when the line was the reader's own, so
     * nothing they typed is thrown away in silence.
     */
    const notTaken = (
      addressed: { readonly sessionId: string; readonly command: UiCommand },
      why: string,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const now = state()
        const text = addressed.command.kind === 'submit' ? addressed.command.text : undefined
        const kept = text !== undefined && now.draft.trim() === '' ? text : undefined
        if (kept !== undefined) rememberDraft(now.sessionId, kept)
        update((current) =>
          withProblem(kept === undefined ? current : withDraft(current, kept), why),
        )
      })

    /**
     * What one command that landed changes here. A model or an effort the page
     * switched is the core's to hold now, so the run state is read again and the
     * seat shows what the next request asks for; everything else says itself in
     * the log.
     */
    const landed = (addressed: { readonly command: UiCommand }): Effect.Effect<void> =>
      addressed.command.kind === 'effort' || addressed.command.kind === 'model'
        ? Effect.asVoid(Queue.offer(refreshes, undefined))
        : Effect.void

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(commands), (addressed) =>
        client.command(addressed).pipe(
          // A false answer is the core saying it does not hold that session: the
          // page opens it again, and the next command lands somewhere real.
          Effect.tap((accepted) =>
            accepted
              ? landed(addressed)
              : Effect.andThen(
                  notTaken(addressed, 'the core did not take the ' + addressed.command.kind),
                  Effect.sync(() =>
                    Queue.offerUnsafe(moves, { kind: 'open', id: addressed.sessionId }),
                  ),
                ),
          ),
          // `ignore` would let a defect kill this fiber, and every later command
          // would sit in the queue with nothing left to send it. A call the far
          // side interrupted is not the page moving on: the command never landed,
          // and the reader is owed that line rather than silence.
          Effect.catchCause((cause) => notTaken(addressed, causeText(cause))),
        ),
      ),
    )
    /** Reads one job and shows it in the pane; stopping it reads it again after. */
    const showJob = (id: string) =>
      Effect.gen(function* () {
        const detail = yield* client.jobDetail({ sessionId: state().sessionId, id })
        yield* Effect.sync(() => update((now) => withPane(now, { kind: 'job', id, detail })))
      })

    /**
     * Stops one job and reads the store again. A stop from the list leaves the
     * pane shut; one from the job's own pane reads that job again.
     */
    const stopJobAndShow = (id: string) =>
      Effect.gen(function* () {
        yield* client.stopJob({ sessionId: state().sessionId, id })
        yield* relist()
        const pane = state().pane
        if (pane?.kind === 'job' && pane.id === id) yield* showJob(id)
      })

    /** Renames, pins, archives, or deletes one session, and leaves a deleted one behind. */
    const applySessionAction = (asked: {
      readonly sessionId: string
      readonly action: SessionAction
    }) =>
      Effect.gen(function* () {
        yield* client.sessionAction({ sessionId: asked.sessionId, action: asked.action })
        yield* relist()
        // A deleted session cannot stay on screen; the page stands on a blank one
        // the way it does when the reader asks for a new session.
        if (asked.action.kind === 'delete' && state().sessionId === asked.sessionId) {
          yield* Queue.offer(moves, { kind: 'blank' })
        }
      })

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(panelAsks), (ask) =>
        Effect.gen(function* () {
          const asked = ask
          if (asked.kind === 'models') {
            const models = yield* client.models()
            yield* Effect.sync(() => update((now) => withModels(now, models)))
            return
          }
          if (asked.kind === 'commands') {
            const commands = yield* client.commands({ sessionId: asked.sessionId })
            // A session switched while the list was on its way keeps its own list:
            // the answer belongs to the page that asked.
            yield* Effect.sync(() =>
              update((now) =>
                now.sessionId === asked.sessionId ? withCommands(now, commands) : now,
              ),
            )
            return
          }
          if (asked.kind === 'files') {
            const paths = yield* client.files({ sessionId: asked.sessionId, query: asked.query })
            // The answer says who asked, so a late one never lands as another session's.
            yield* Effect.sync(() =>
              update((now) =>
                withFiles(now, {
                  sessionId: asked.sessionId,
                  query: asked.query,
                  paths,
                }),
              ),
            )
            return
          }
          if (asked.kind === 'sessionAction') {
            yield* applySessionAction(asked)
            return
          }
          if (asked.kind === 'job') {
            yield* showJob(asked.id)
            return
          }
          if (asked.kind === 'stopJob') {
            yield* stopJobAndShow(asked.id)
            return
          }
          if (asked.kind === 'stopSubagent') {
            yield* client.stopSubagent({ sessionId: state().sessionId, id: asked.id })
            yield* relist()
            return
          }
          // Only the sheet asks for the settings file to keep the pick; the seat's
          // pick is the choice of this run alone.
          yield* client.setModel({
            model: asked.model,
            remember: asked.kind === 'setModel',
          })
          // Read it back, so the pane shows what the sessions to come start from.
          const settings = yield* client.settings()
          yield* Effect.sync(() => update((now) => withSettings(now, settings)))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => update((now) => withProblem(now, causeText(cause)))),
          ),
        ),
      ),
    )

    /** Reads the folders a new session may start in, for the picker beside New session. */
    const readWorkspaces = () =>
      Effect.gen(function* () {
        const listed = yield* client.workspaces()
        yield* Effect.sync(() => update((now) => withWorkspaces(now, listed)))
      })

    /** Answers one workspace ask: the list, one folder read for the dialog, or one added. */
    const answerWorkspaceAsk = (asked: WorkspaceAsk) =>
      asked.kind === 'browse'
        ? client.browseDirectories({ path: asked.path }).pipe(
            Effect.map((view): BrowseAnswer => ({ kind: 'listed', view })),
            Effect.catchCause((cause) =>
              Effect.succeed<BrowseAnswer>({ kind: 'refused', message: causeText(cause) }),
            ),
            // The dialog may be gone by now; the answer belongs to the page that asked.
            Effect.tap((answer) => Effect.sync(() => asked.reply(answer))),
            Effect.asVoid,
          )
        : asked.kind === 'list'
          ? readWorkspaces()
          : // Read the list back, so the picker offers the folder that just joined it.
            client.addWorkspace({ cwd: asked.cwd }).pipe(Effect.andThen(readWorkspaces()))

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(workspaceAsks), (asked) =>
        answerWorkspaceAsk(asked).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => update((now) => withProblem(now, causeText(cause)))),
          ),
        ),
      ),
    )

    const settings = yield* client.settings()
    yield* Effect.sync(() => update((now) => withSettings(now, settings)))

    const listed = yield* client.sessions()
    yield* Effect.sync(() => update((now) => withSessions(now, listed.items)))
    yield* Effect.sync(() => update((now) => withOpened(now, listed.opened)))
    yield* Effect.forEach(listed.opened, watch)

    // The session the page opens, then one more for every move: a click, a new
    // session, or the first message. A page the server holds none for opens
    // none: looking at the UI is not a request for a session.
    const wanted = sessionToOpen(state().sessionId, search, listed.initial)
    const opening: ReadonlyArray<Move> = wanted === undefined ? [] : [{ kind: 'open', id: wanted }]
    yield* Stream.runForEach(
      Stream.concat(Stream.fromIterable(opening), Stream.fromQueue(moves)),
      (move) =>
        (move.kind === 'blank' ? standOnBlank() : show(move.id, move.cwd)).pipe(
          Effect.catchCause((cause) =>
            unlessInterrupted(
              cause,
              Effect.sync(() => {
                // A line that never reached a session comes back to the reader.
                if (owed !== undefined) {
                  const text = owed
                  owed = undefined
                  rememberDraft(state().sessionId, text)
                  update((now) => withDraft(now, text))
                }
                update((now) => withProblem(now, causeText(cause)))
              }),
            ),
          ),
        ),
    )
  })

  const runnable = withoutServices(
    program.pipe(
      Effect.ensuring(Effect.sync(() => update((now) => withConnection(now, false)))),
      Effect.provide(RpcClient.layerProtocolSocket(KEEP_ALIVE)),
      Effect.provide(Socket.layerWebSocket(url)),
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
      Effect.provide(RpcSerialization.layerJson),
      Effect.scoped,
    ),
  )

  const start = (): void => {
    // A page opened for no session keeps a line typed here before the reload.
    const blank = readDraft('')
    if (blank !== '') {
      drafts = drafted(drafts, '', blank)
      update((now) => withDraft(now, blank))
    }
    const theme = keptTheme()
    update((now) => withTheme(now, theme))
    showTheme(theme)
    bridge.start(runnable)
  }

  const sendTo = (sessionId: string, command: UiCommand): void => {
    Queue.offerUnsafe(commands, { sessionId, command })
  }

  return {
    state,
    watched,
    start,
    stop: () => {
      // The page is going away: what is pending is written.
      flushDrafts()
      bridge.stop()
    },
    setDraft: (draft) => {
      rememberDraft(state().sessionId, draft)
      update((now) => withDraft(now, draft))
    },
    submit: () => {
      const current = state()
      const value = current.draft.trim()
      if (value === '') return
      if (current.sessionId === '') {
        // The session this line starts is already on its way; keep the line.
        if (owed !== undefined) return
        owed = value
        Queue.offerUnsafe(moves, { kind: 'open', id: undefined, cwd: blankCwd })
        clearDraft(current.sessionId)
        return
      }
      const ask = current.conversation.ask
      sendTo(
        current.sessionId,
        ask === undefined
          ? { kind: 'submit', text: value }
          : { kind: 'answer', id: ask.id, answer: value },
      )
      clearDraft(current.sessionId)
    },
    send: (command) => sendTo(state().sessionId, command),
    sendTo,
    moveTo: (id, cwd) => {
      if (id === undefined) blankCwd = cwd
      Queue.offerUnsafe(moves, id === undefined ? { kind: 'blank' } : { kind: 'open', id })
    },
    chooseTheme: (theme) => {
      update((now) => withTheme(now, theme))
      showTheme(theme)
      keepTheme(theme)
    },
    showPane: (pane) => update((current) => withPane(current, pane)),
    openJob: (id) => {
      update((now) => withPane(now, { kind: 'job', id, detail: undefined }))
      Queue.offerUnsafe(panelAsks, { kind: 'job', id })
    },
    stopJob: (id) => Queue.offerUnsafe(panelAsks, { kind: 'stopJob', id }),
    stopSubagent: (id) => Queue.offerUnsafe(panelAsks, { kind: 'stopSubagent', id }),
    askModels: () => Queue.offerUnsafe(panelAsks, { kind: 'models' }),
    askCommands: () =>
      Queue.offerUnsafe(panelAsks, { kind: 'commands', sessionId: state().sessionId }),
    askFiles: (query) =>
      Queue.offerUnsafe(panelAsks, { kind: 'files', sessionId: state().sessionId, query }),
    askWorkspaces: () => Queue.offerUnsafe(workspaceAsks, { kind: 'list' }),
    browseDirectories: (path, reply) =>
      Queue.offerUnsafe(workspaceAsks, { kind: 'browse', path, reply }),
    addWorkspace: (cwd) => Queue.offerUnsafe(workspaceAsks, { kind: 'add', cwd }),
    chooseModel: (model) => {
      const current = state()
      // The session on screen switches with the command; the choice is the run's, so
      // the sessions opened from now on start from it as well.
      if (current.sessionId !== '') sendTo(current.sessionId, { kind: 'model', model })
      Queue.offerUnsafe(panelAsks, { kind: 'chooseModel', model })
    },
    setModel: (model) => Queue.offerUnsafe(panelAsks, { kind: 'setModel', model }),
    act: (sessionId, action) =>
      Queue.offerUnsafe(panelAsks, { kind: 'sessionAction', sessionId, action }),
  }
}
