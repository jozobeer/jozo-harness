import { describe, expect, test } from 'vitest'
import type { UiCommand, UiEvent, UiHost, UiSessionEvent } from '@jozo-harness/ui-protocol'
import { makeScheduleStore } from '@jozo-harness/tools-tier1'
import { Cause, Deferred, Effect, Queue, Stream, type Scope } from 'effect'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  serveWeb,
  WebError,
  type OpenSession,
  type SessionFactory,
  type SettingsPort,
  type WorkspacesPort,
} from '../src/server/index.ts'
import type { JobDetailView, RunStateView, SessionSummary } from '../src/shared/rpc.ts'
import { createSessionStore, type BrowseAnswer, type SessionStore } from '../client-solid/store.ts'
import { draftKey } from '../src/ui/draft.ts'
import { THEME_KEY } from '../src/ui/theme.ts'

/**
 * The page's store against the real server, over a real socket. The store is the
 * browser's half of the pair, and the ways the core can disappoint it — a feed
 * that drops with no word, a message the core will not take — are the ones that
 * read to a reader as input that does nothing.
 */

/** What the page's browser calls did, for a run outside a browser. */
interface StubbedBrowser {
  readonly kept: () => string | undefined
  /** What storage holds under one key, as a page opened again would read it. */
  readonly stored: (key: string) => string | undefined
  readonly attribute: () => string | undefined
  /** The URL the page last put in the address bar. */
  readonly address: () => string | undefined
  /** Paints the frame the page is waiting on, if it is waiting on one. */
  readonly paint: () => void
}

/** The little of the browser the store touches, for a run outside one. */
const stubTheBrowser = (options: { readonly frames?: boolean } = {}): StubbedBrowser => {
  const globals = globalThis as unknown as Record<string, unknown>
  const kept = new Map<string, string>()
  let address: string | undefined
  const dataset: Record<string, string | undefined> = {}
  globals.localStorage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => {
      kept.set(key, value)
    },
    removeItem: (key: string) => {
      kept.delete(key)
    },
  }
  globals.document = { documentElement: { dataset } }
  globals.history = {
    replaceState: (_data: unknown, _unused: string, url?: string) => {
      address = url
    },
  }
  globals.window = {
    location: { protocol: 'http:', host: '127.0.0.1:8080', pathname: '/', search: '?session=a' },
  }
  // The page folds what arrived once per frame. A run that watches that hands the
  // page a clock of its own and paints when it means to; every other run has no
  // frame to wait for and folds on the next turn of the event loop.
  const waiting: Array<() => void> = []
  globals.requestAnimationFrame =
    options.frames === true
      ? (run: () => void) => {
          waiting.push(run)
          return waiting.length
        }
      : undefined
  return {
    kept: () => kept.get(THEME_KEY),
    stored: (key: string) => kept.get(key),
    attribute: () => dataset.theme,
    address: () => address,
    paint: () => {
      for (const run of waiting.splice(0, waiting.length)) run()
    },
  }
}

interface FakeHost {
  readonly summary: SessionSummary
  readonly host: UiHost
  readonly runState: () => RunStateView
  readonly jobOutput: (id: string) => Effect.Effect<JobDetailView, WebError>
  readonly stopJob: (id: string) => Effect.Effect<void, WebError>
  readonly stopSubagent: (id: string) => Effect.Effect<void, WebError>
  /** The children the run state reports now, as a turn that started one would. */
  readonly setSubagents: (subagents: RunStateView['subagents']) => void
  /** The jobs the run state reports now, as a running command would. */
  readonly setJobs: (jobs: RunStateView['jobs']) => void
  /** The skills the run state reports now, as a forced load would. */
  readonly setSkills: (skills: ReadonlyArray<string>) => void
  /** What one job detail read returns now, while its output grows. */
  readonly setJobDetail: (detail: JobDetailView) => void
  /** How many times a client read a job detail. */
  readonly jobReads: () => number
  /** The children a page stopped, in the order it asked. */
  readonly stopped: Array<string>
  /** The jobs a page stopped, in the order it asked. */
  readonly stoppedJobs: Array<string>
  readonly commands: ReadonlyArray<UiCommand>
  /** Appends to the log and feeds whoever follows it now. */
  readonly said: (event: UiEvent) => void
  /** Drops every feed of this session, as a defect on the wire does. */
  readonly dropped: () => void
  /** How many times a client asked to follow this session. */
  readonly followed: () => number
  /** How many times a client read the run state: once when it opens, once per read again. */
  readonly states: () => number
  /** False makes `submit` die, as a core that fell over does. */
  accepting: boolean
  /** True makes opening a session fail, as a refused preset does. */
  refusing: boolean
}

const event = (seq: number, type: string, data: unknown): UiEvent => ({
  kind: 'session',
  event: { seq, time: seq, type, data } as UiSessionEvent,
})

const turn = (seq: number, text: string): UiEvent =>
  event(seq, 'user/message', { text, source: 'user' })

const makeHost = (id: string, cwd = '/work'): FakeHost => {
  const log: Array<UiEvent> = []
  const subscribers = new Set<Queue.Queue<UiEvent>>()
  const commands: Array<UiCommand> = []
  const stopped: Array<string> = []
  const stoppedJobs: Array<string> = []
  let follows = 0
  let states = 0
  let effort = ''
  let model = 'stub/model'
  let subagents: RunStateView['subagents'] = []
  let jobs: RunStateView['jobs'] = []
  let skills: ReadonlyArray<string> = []
  let jobDetail: JobDetailView | undefined
  let jobReads = 0
  const host: FakeHost = {
    summary: { id, cwd, createdAt: 1, updatedAt: 1, title: '' },
    runState: () => {
      states += 1
      return {
        goal: null,
        schedules: [],
        jobs,
        subagents,
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills,
        promptSections: [],
        queued: [],
        steering: [],
        model,
        effort,
        efforts: ['low', 'high'],
      }
    },
    jobOutput: (jobId) => {
      jobReads += 1
      return jobDetail === undefined || jobDetail.id !== jobId
        ? Effect.fail(new WebError({ message: 'no such job' }))
        : Effect.succeed(jobDetail)
    },
    stopJob: (jobId) =>
      Effect.sync(() => {
        stoppedJobs.push(jobId)
      }),
    stopSubagent: (childId) =>
      Effect.sync(() => {
        stopped.push(childId)
      }),
    setSubagents: (next) => {
      subagents = next
    },
    setJobs: (next) => {
      jobs = next
    },
    setSkills: (next) => {
      skills = next
    },
    setJobDetail: (next) => {
      jobDetail = next
    },
    jobReads: () => jobReads,
    stopped,
    stoppedJobs,
    commands,
    accepting: true,
    refusing: false,
    said: (one) => {
      log.push(one)
      for (const queue of subscribers.values().toArray()) Queue.offerUnsafe(queue, one)
    },
    dropped: () => {
      for (const queue of subscribers.values().toArray()) {
        Queue.failCauseUnsafe(queue, Cause.die('the feed dropped'))
      }
      subscribers.clear()
    },
    followed: () => follows,
    states: () => states,
    host: {
      // Every follower is handed the log first, then what happens next: the same
      // shape the real host has, and what lets a second look recover a gap.
      events: Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            follows += 1
            const queue = yield* Queue.unbounded<UiEvent>()
            for (const one of log) yield* Queue.offer(queue, one)
            subscribers.add(queue)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                subscribers.delete(queue)
              }),
            )
            return Stream.fromQueue(queue)
          }),
        ),
      ),
      submit: (text, mode) =>
        Effect.suspend(() => {
          commands.push(
            mode === undefined ? { kind: 'submit', text } : { kind: 'submit', text, mode },
          )
          return host.accepting ? Effect.void : Effect.die(new Error('the core fell over'))
        }),
      approve: (callId, approved) =>
        Effect.sync(() => {
          commands.push({ kind: 'approve', callId, approved })
        }),
      answer: (askId, answer) =>
        Effect.sync(() => {
          commands.push({ kind: 'answer', id: askId, answer })
        }),
      cancel: () =>
        Effect.sync(() => {
          commands.push({ kind: 'cancel' })
        }),
      // The session's effort is the host's to hold, as the core holds it.
      setEffort: (next) =>
        Effect.sync(() => {
          commands.push({ kind: 'effort', effort: next })
          effort = next
        }),
      // The session's route is the host's to hold too; the log records what is sent.
      setModel: (next) =>
        Effect.sync(() => {
          commands.push({ kind: 'model', model: next })
          model = next
        }),
      answerApproval: () => Effect.succeed(true),
      answerAsk: () => Effect.succeed(''),
      serveQuestions: () => Effect.succeed([]),
      rate: () => Effect.void,
    },
  }
  return host
}

const openOf = (host: FakeHost): OpenSession => ({
  summary: host.summary,
  host: host.host,
  commands: () => [],
  runState: host.runState,
  jobOutput: host.jobOutput,
  stopJob: host.stopJob,
  stopSubagent: host.stopSubagent,
  // These tests never delete a session; the state still says what runs.
  busy: () => {
    const state = host.runState()
    return (
      state.jobs.some((job) => job.running) ||
      state.subagents.some((child) => child.status === 'running')
    )
  },
})

interface FakeSettings {
  /** Every route a page chose for the run, with whether it asked to keep it. */
  readonly chosen: Array<{ readonly model: string; readonly remember: boolean }>
  /** Every effort a page chose for the run. */
  readonly chosenEffort: Array<string>
  readonly port: SettingsPort
}

const makeSettings = (): FakeSettings => {
  const chosen: Array<{ readonly model: string; readonly remember: boolean }> = []
  const chosenEffort: Array<string> = []
  let route = 'stub/model'
  let effort = ''
  return {
    chosen,
    chosenEffort,
    port: {
      read: () =>
        Effect.succeed({
          model: route,
          effort,
          efforts: ['low', 'high'],
          settingsPath: '/work/settings.yml',
          cwd: '/work',
          sessionRoot: '/work/sessions',
        }),
      models: () => Effect.succeed(['stub/model']),
      setModel: (model, remember) =>
        Effect.sync(() => {
          chosen.push({ model, remember })
          route = model
        }),
      setEffort: (next) =>
        Effect.sync(() => {
          chosenEffort.push(next)
          effort = next
        }),
    },
  }
}

interface Served {
  readonly wsUrl: string
  readonly stop: Deferred.Deferred<void>
  readonly root: string
  /** How many times the page asked the server to open or create a session. */
  readonly opens: () => number
}

/** The folders a page may start in; these tests never open a new workspace. */
const workspacesPort: WorkspacesPort = {
  list: () => Effect.succeed({ cwd: '/work', items: [{ cwd: '/work', lastUsedAt: 0 }] }),
  browse: (path) =>
    path === '/work/missing'
      ? Effect.fail(new WebError({ message: 'no such directory' }))
      : Effect.succeed({ path: path === '' ? '/work' : path, parent: '/', items: ['/work/src'] }),
  add: () => Effect.void,
}

/** Serves one fake host until the test's scope closes. */
const serve = (
  host: FakeHost,
  /** False serves a server that holds no session yet, as one just started does. */
  options: {
    readonly held?: boolean
    readonly settings?: FakeSettings
  } = {},
): Effect.Effect<Served, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<string>()
    const stop = yield* Deferred.make<void>()
    let opens = 0
    const factory: SessionFactory = {
      list: () => Effect.succeed([host.summary]),
      open: () => {
        opens += 1
        return host.refusing
          ? Effect.fail(new WebError({ message: 'the session was refused' }))
          : Effect.succeed(openOf(host))
      },
    }
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'jzh-store-test-')))
    yield* Effect.forkScoped(
      serveWeb({
        ...(options.held === false
          ? {}
          : { initial: { session: openOf(host), close: () => Effect.void } }),
        factory,
        settings: (options.settings ?? makeSettings()).port,
        schedules: makeScheduleStore(join(root, 'schedules.json')),
        workspaces: workspacesPort,
        commands: () => [],
        plugins: {
          view: () => ({ rows: [], catalog: [], failures: [] }),
          known: () => [],
          change: async () => ({ ok: true }),
        },
        port: 0,
        staticRoot: root,
        onReady: (urls) => {
          void Effect.runSync(Deferred.succeed(ready, urls.local))
        },
        interrupt: Deferred.await(stop),
      }),
    )
    const page = new URL(yield* Deferred.await(ready))
    const code = page.searchParams.get('code')
    if (code === null) throw new Error('the server reported no code')
    return {
      wsUrl: 'ws://' + page.host + '/ui?code=' + code,
      stop,
      root,
      opens: () => opens,
    }
  })

/** Waits for what the page reaches on its own, or fails saying what never came. */
const until = (wanted: () => boolean, what: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (wanted()) return
      yield* Effect.sleep('25 millis')
    }
    return yield* Effect.die(new Error('the page never ' + what))
  })

const saidTexts = (store: SessionStore): ReadonlyArray<string> =>
  store.state().conversation.blocks.flatMap((block) => (block.kind === 'user' ? [block.text] : []))

/** Serves one host, starts the page's store on it, and hands both to the body. */
const withStore = (
  host: FakeHost,
  body: (store: SessionStore, served: Served) => Effect.Effect<void>,
  options: {
    readonly held?: boolean
    readonly settings?: FakeSettings
  } = {},
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const served = yield* serve(host, options)
      const store = createSessionStore({
        url: served.wsUrl,
        search: '',
      })
      store.start()
      // A server that holds nothing leaves the page with nothing open: the
      // connection is what says the page is ready, not a session.
      yield* until(() => store.state().connected, 'connected to the server')
      if (options.held !== false) {
        yield* until(() => store.state().sessionId === 'a', 'opened the session')
      }
      yield* body(store, served)
      store.stop()
      yield* Deferred.succeed(served.stop, undefined)
      yield* Effect.promise(() => rm(served.root, { recursive: true, force: true }))
    }),
  )

describe('the page store', () => {
  test('a long log keeps unfolding while the page reads the store again', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    // The first look replays the whole log in one burst, and the second event in
    // it asks the page to read the store again. A feed that makes that call
    // itself stops draining: the client stops reading the socket while a feed's
    // buffer holds events, so the answer sits behind the very events the call is
    // holding up, and the page stays empty with nothing said about why.
    host.said(event(1, 'turn/start', { turn: 1 }))
    host.said(event(2, 'agent/inbox/queued', { message: { source: 'user', text: 'the ask' } }))
    for (let index = 0; index < 40; index += 1) {
      host.said(turn(3 + index, 'line ' + String(index + 1)))
    }
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          yield* until(() => saidTexts(store).includes('line 40'), 'showed the whole log')
          // The read again happened too, on the page's own fiber.
          yield* until(() => host.states() >= 2, 'read the run state again')
        }),
      ),
    )
  }, 15_000)

  test('an @word reads the files of the session workspace and lands tagged', async () => {
    stubTheBrowser()
    const root = await mkdtemp(join(tmpdir(), 'jzh-store-files-'))
    await mkdir(join(root, 'components'), { recursive: true })
    await writeFile(join(root, 'components', 'composer.tsx'), 'export {}')
    const host = makeHost('a', root)
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          store.askFiles('comp')
          yield* until(
            () => (store.state().files?.paths.length ?? 0) > 0,
            'read the files of the workspace',
          )
          expect(store.state().files).toEqual({
            sessionId: 'a',
            query: 'comp',
            paths: ['components/composer.tsx'],
          })
        }),
      ).pipe(Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true })))),
    )
  }, 15_000)

  test('the Add workspace dialog reads a folder and hears why it cannot', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          const answers: Array<BrowseAnswer> = []
          store.browseDirectories('', (answer) => answers.push(answer))
          yield* until(() => answers.length === 1, 'read the starting folder')
          expect(answers[0]).toEqual({
            kind: 'listed',
            view: { path: '/work', parent: '/', items: ['/work/src'] },
          })
          store.browseDirectories('/work/missing', (answer) => answers.push(answer))
          yield* until(() => answers.length === 2, 'heard the refusal')
          expect(answers[1]).toEqual({ kind: 'refused', message: 'no such directory' })
        }),
      ),
    )
  }, 15_000)

  test('a goal written to the log makes the page read its run state again', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          const before = host.states()
          host.said(
            event(1, 'goal/updated', {
              objective: 'ship it',
              phase: 'active',
              maxGoalRounds: 8,
            }),
          )
          yield* until(() => host.states() > before, 'read the run state after the goal changed')
          expect(store.state().run).toBeDefined()
        }),
      ),
    )
  }, 15_000)

  test('a skill load written outside a turn makes the page read its run state again', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          const before = host.states()
          host.setSkills(['review'])
          host.said(
            event(1, 'tool/call', {
              callId: 's1',
              name: 'skill',
              arguments: '{"name":"review"}',
              summary: '/home/me/.agents/skills/review/SKILL.md',
            }),
          )

          yield* until(() => host.states() > before, 'read the run state after the load')
          expect(store.state().run?.skills).toEqual(['review'])
        }),
      ),
    )
  }, 15_000)

  test('a running turn reads the run state again, so a subagent that starts mid-turn appears', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          host.said(event(1, 'turn/start', { turn: 1 }))
          yield* until(() => store.state().conversation.running, 'saw the turn start')
          const before = host.states()
          const child = { id: 'child-1', status: 'running', startedAt: Date.now() }
          host.setSubagents([child])

          yield* until(() => host.states() > before, 'read the run state during the turn')
          yield* until(
            () => store.state().run?.subagents.length === 1,
            'showed the subagent that started mid-turn',
          )
          expect(store.state().run?.subagents).toEqual([child])
        }),
      ),
    )
  }, 15_000)

  test('stopping a subagent asks the server and reads the run state again', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          const before = host.states()
          store.stopSubagent('child-1')

          yield* until(() => host.stopped.includes('child-1'), 'asked to stop the subagent')
          yield* until(() => host.states() > before, 'read the run state after the stop')
        }),
      ),
    )
  }, 15_000)

  test('a running job keeps the run state fresh after no turn is running', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    const job = {
      id: 'job-1',
      command: 'sleep 30',
      running: true,
      startedAt: Date.now() - 2_000,
      tail: 'working',
    }
    host.setJobs([job])
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          const before = host.states()
          yield* until(() => host.states() > before, 'read the run state while the job runs')
          expect(store.state().run?.jobs).toEqual([job])
        }),
      ),
    )
  }, 15_000)

  test('an open running job reads its output again, so the pane keeps growing', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    host.setJobs([
      {
        id: 'job-1',
        command: 'echo one',
        running: true,
        startedAt: Date.now(),
        tail: 'one',
      },
    ])
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          host.setJobDetail({ id: 'job-1', command: 'echo one', running: true, output: 'one' })
          store.openJob('job-1')
          yield* until(() => host.jobReads() >= 1, 'read the job when it opened')
          expect(store.state().pane).toMatchObject({
            kind: 'job',
            id: 'job-1',
            detail: { output: 'one' },
          })

          host.setJobDetail({
            id: 'job-1',
            command: 'echo one',
            running: true,
            output: 'one\ntwo',
          })
          yield* until(() => host.jobReads() >= 2, 'read the open job again while it runs')
          const output = (): string | undefined => {
            const pane = store.state().pane
            return pane?.kind === 'job' ? pane.detail?.output : undefined
          }
          yield* until(() => output() === 'one\ntwo', 'showed the output that arrived')
        }),
      ),
    )
  }, 15_000)

  test('stopping a job from the run list reads the state again and leaves the pane shut', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    host.setJobDetail({ id: 'job-1', command: 'sleep 30', running: true, output: 'working' })
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          const before = host.states()
          store.stopJob('job-1')

          yield* until(() => host.stoppedJobs.includes('job-1'), 'asked to stop the job')
          yield* until(() => host.states() > before, 'read the run state after the stop')
          // The list is not a request to open the job: the pane the reader had stays.
          expect(store.state().pane).toEqual({ kind: 'run' })
        }),
      ),
    )
  }, 15_000)

  test('a log that arrives at once is drawn once, when the frame comes', async () => {
    const browser = stubTheBrowser({ frames: true })
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          yield* until(() => host.followed() >= 1, 'followed the session')
          // A whole log arriving at once. Folding it is milliseconds; drawing the
          // conversation again per event is what makes a long session open in
          // seconds, so the page holds the batch and lets one frame draw it all.
          const lines = 200
          for (let index = 0; index < lines; index += 1) {
            host.said(turn(index + 1, 'line ' + String(index + 1)))
          }
          // Time enough for every event to reach the page, with no frame given yet.
          yield* Effect.sleep('250 millis')
          expect(saidTexts(store)).not.toContain('line ' + String(lines))

          // The frame draws the whole batch, and none of it was lost on the way.
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (saidTexts(store).includes('line ' + String(lines))) break
            browser.paint()
            yield* Effect.sleep('25 millis')
          }
          expect(saidTexts(store)).toContain('line ' + String(lines))
          expect(saidTexts(store)).toHaveLength(lines)
        }),
      ),
    )
  }, 15_000)

  test('following again brings the turns a dropped feed missed', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          yield* until(() => host.followed() >= 1, 'followed the session')
          host.said(turn(1, 'one'))
          yield* until(() => saidTexts(store).includes('one'), 'showed the first turn')

          // The feed dies with no word to the page, and nothing the reader did.
          host.dropped()
          yield* until(() => host.followed() >= 3, 'followed the session again')

          // A turn logged while nothing was listening: the second look replays
          // the log, so the page catches up without the reader asking again.
          host.said(turn(2, 'two'))
          yield* until(() => saidTexts(store).includes('two'), 'showed the turn it missed')
        }),
      ),
    )
  })

  test('a message the core never took is said out loud, and the draft comes back', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          // The call dies, which takes every pending call of the page with it.
          host.accepting = false
          store.setDraft('a message nobody takes')
          store.submit()
          // The call dies, which takes every pending call of the page with it: the
          // line comes back to the composer, so nothing the reader typed is lost.
          yield* until(
            () => store.state().draft === 'a message nobody takes',
            'gave the message back',
          )

          // The pipeline outlives it: the next message still reaches the core.
          host.accepting = true
          store.submit()
          yield* until(
            () => host.commands.filter((one) => one.kind === 'submit').length >= 2,
            'sent the next message',
          )

          // A session the server does not hold is refused without a word of its
          // own: the page says so, looks at the session again rather than taking
          // the next line into the same void, and keeps saying why.
          const followed = host.followed()
          store.sendTo('nobody-holds-this', { kind: 'submit', text: 'into the void' })
          yield* until(() => host.followed() > followed, 'looked at the session again')
          yield* until(() => store.state().problem !== '', 'said the session was refused')
        }),
      ),
    )
  })

  test('a steer reaches the core with the mode the composer asked for', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          store.setDraft('join the step')
          store.submit('steer')
          yield* until(
            () => host.commands.some((command) => command.kind === 'submit'),
            'sent the steer',
          )
          expect(host.commands).toContainEqual({
            kind: 'submit',
            text: 'join the step',
            mode: 'steer',
          })
        }),
      ),
    )
  })

  test('the browser the page runs in is named in one place', () => {
    const browser = stubTheBrowser()
    // No url and no search: both come from the page the store is running in.
    const store = createSessionStore()
    store.chooseTheme('dark')
    expect(store.state().theme).toBe('dark')
    expect(browser.kept()).toBe('dark')
    expect(browser.attribute()).toBe('dark')
  })

  test('New session moves the page to a blank one without asking for a session', async () => {
    const browser = stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store, served) =>
        Effect.gen(function* () {
          const opened = served.opens()
          expect(browser.address()).toBe('?session=a')

          store.moveTo(undefined)
          yield* until(() => store.state().sessionId === '', 'moved to the blank page')
          // A second and a third press are the same move, not two more sessions.
          store.moveTo(undefined)
          store.moveTo(undefined)
          yield* Effect.sleep('100 millis')

          // Nothing reached the server, and the page holds no session on screen.
          expect(served.opens()).toBe(opened)
          expect(store.state().sessions.map((item) => item.id)).toEqual(['a'])
          expect(store.state().conversation.blocks).toEqual([])
          expect(store.state().run).toBeUndefined()
          // The address bar names no session, so a reload does not go back to one.
          expect(browser.address()).toBe('/')
        }),
      ),
    )
  }, 15_000)

  test('the first line typed on the blank page opens one session and is sent to it', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store, served) =>
        Effect.gen(function* () {
          store.moveTo(undefined)
          yield* until(() => store.state().sessionId === '', 'moved to the blank page')
          const opened = served.opens()

          store.setDraft('the first line')
          store.submit()

          yield* until(() => served.opens() === opened + 1, 'opened one session for the line')
          yield* until(
            () => host.commands.some((command) => command.kind === 'submit'),
            'sent the line',
          )
          // One line asked for one session, and the line went there as it was.
          yield* Effect.sleep('100 millis')
          expect(served.opens()).toBe(opened + 1)
          expect(host.commands).toContainEqual({ kind: 'submit', text: 'the first line' })
          expect(store.state().draft).toBe('')
        }),
      ),
    )
  }, 15_000)

  test('a page the server holds no session for opens one for the first line', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(
        host,
        (store) =>
          Effect.gen(function* () {
            // Looking at the page asks for nothing: give it time to ask, then check.
            yield* Effect.sleep('250 millis')
            expect(store.state().sessionId).toBe('')
            expect(host.followed()).toBe(0)

            store.setDraft('the first line')
            store.submit()

            // The line starts the session it is sent to, and reaches it.
            yield* until(() => store.state().sessionId === 'a', 'opened a session for the line')
            yield* until(
              () => host.commands.some((command) => command.kind === 'submit'),
              'sent the line',
            )
            expect(host.commands).toContainEqual({ kind: 'submit', text: 'the first line' })
            expect(store.state().draft).toBe('')
          }),
        { held: false },
      ),
    )
  }, 15_000)

  test('a line is given back when no session can be opened for it', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(
        host,
        (store) =>
          Effect.gen(function* () {
            host.refusing = true
            store.setDraft('into the void')
            store.submit()

            // Nothing took it, so the reader gets the line back rather than silence.
            yield* until(() => store.state().draft === 'into the void', 'gave the line back')
            expect(store.state().problem).toContain('refused')
          }),
        { held: false },
      ),
    )
  }, 15_000)

  test('the effort a page switches a session to is read back', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          // Nothing named an effort, so the provider chooses.
          expect(store.state().run?.effort).toBe('')

          store.send({ kind: 'effort', effort: 'high' })

          // The switch is the core's to make, and what the core now holds is what
          // the page shows: the seat says what the next request will ask for.
          yield* until(() => store.state().run?.effort === 'high', 'showed the switched effort')
          expect(host.commands).toContainEqual({ kind: 'effort', effort: 'high' })
        }),
      ),
    )
  }, 15_000)

  test('the model a page picks is read back from the session it picked it for', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          // The session started on the route the run resolved.
          expect(store.state().run?.model).toBe('stub/model')

          store.send({ kind: 'model', model: 'stub/other' })

          // The route is the session's own from now on, and the seat reads it from
          // the run state rather than from the log, which has not seen a request yet.
          yield* until(() => store.state().run?.model === 'stub/other', 'showed the picked model')
          expect(host.commands).toContainEqual({ kind: 'model', model: 'stub/other' })
        }),
      ),
    )
  }, 15_000)

  test('a pick switches the session on screen and the sessions opened after it', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    const settings = makeSettings()
    await Effect.runPromise(
      withStore(
        host,
        (store) =>
          Effect.gen(function* () {
            store.chooseModel('stub/other')

            // The session on screen switches, and the choice is the run's as well, so
            // the sessions opened from now on start from it.
            yield* until(() => store.state().run?.model === 'stub/other', 'showed the picked model')
            expect(host.commands).toContainEqual({ kind: 'model', model: 'stub/other' })
            yield* until(() => settings.chosen.length > 0, 'chose the route for the run')
            expect(settings.chosen).toEqual([{ model: 'stub/other', remember: false }])
            // The sheet reads back what the next session will start from.
            yield* until(
              () => store.state().settings?.model === 'stub/other',
              'read the choice back',
            )
          }),
        { settings },
      ),
    )
  }, 15_000)

  test('a pick before any session is open is the route the next one starts from', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    const settings = makeSettings()
    await Effect.runPromise(
      withStore(
        host,
        (store) =>
          Effect.gen(function* () {
            // Looking at the page opens nothing, so there is no session to address.
            expect(store.state().sessionId).toBe('')
            store.chooseModel('stub/other')

            yield* until(() => settings.chosen.length > 0, 'chose the route for the run')
            expect(settings.chosen).toEqual([{ model: 'stub/other', remember: false }])
            expect(host.commands).toEqual([])
          }),
        { held: false, settings },
      ),
    )
  }, 15_000)

  test('a pick before any session is open is the effort the next one starts from', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    const settings = makeSettings()
    await Effect.runPromise(
      withStore(
        host,
        (store) =>
          Effect.gen(function* () {
            // Looking at the page opens nothing, so there is no session to address.
            expect(store.state().sessionId).toBe('')
            store.chooseEffort('high')

            yield* until(() => settings.chosenEffort.length > 0, 'chose the effort for the run')
            expect(settings.chosenEffort).toEqual(['high'])
            // The seat reads back what a session opened now starts from.
            yield* until(() => store.state().settings?.effort === 'high', 'read the effort back')
            expect(host.commands).toEqual([])
          }),
        { held: false, settings },
      ),
    )
  }, 15_000)

  test('an effort pick while a session is open is that session alone', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    const settings = makeSettings()
    await Effect.runPromise(
      withStore(
        host,
        (store) =>
          Effect.gen(function* () {
            store.chooseEffort('high')

            // The open session switches; the run's choice, which the next session
            // would start from, stays where it was.
            yield* until(() => store.state().run?.effort === 'high', 'showed the switched effort')
            expect(host.commands).toContainEqual({ kind: 'effort', effort: 'high' })
            expect(settings.chosenEffort).toEqual([])
          }),
        { settings },
      ),
    )
  }, 15_000)

  test('the sheet writes the pick the runs after this one read', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    const settings = makeSettings()
    await Effect.runPromise(
      withStore(
        host,
        (store) =>
          Effect.gen(function* () {
            store.setModel('stub/kept')

            yield* until(() => settings.chosen.length > 0, 'wrote the model down')
            expect(settings.chosen).toEqual([{ model: 'stub/kept', remember: true }])
            // The session on screen is not the sheet's to switch.
            expect(host.commands).toEqual([])
          }),
        { settings },
      ),
    )
  }, 15_000)

  test('a draft belongs to the session it was typed in', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store) =>
        Effect.gen(function* () {
          store.setDraft('half typed for a')
          store.moveTo(undefined)
          yield* until(
            () => store.state().sessionId === '' && store.state().draft === '',
            'moved to a blank page with an empty composer',
          )

          store.moveTo('a')
          yield* until(
            () => store.state().draft === 'half typed for a',
            'brought the session its draft back',
          )
          expect(store.state().sessionId).toBe('a')
        }),
      ),
    )
  }, 15_000)

  test('a draft survives a reload, and is forgotten once it is sent', async () => {
    const browser = stubTheBrowser()
    const host = makeHost('a')
    await Effect.runPromise(
      withStore(host, (store, served) =>
        Effect.gen(function* () {
          store.setDraft('kept across a reload')
          // The page writes on a delay, as it does for every keystroke.
          yield* Effect.sleep('400 millis')

          // A reload is another page on the same storage, reading the same session.
          const again = createSessionStore({ url: served.wsUrl, search: '' })
          again.start()
          yield* until(() => again.state().sessionId === 'a', 'opened the session again')
          yield* until(() => again.state().draft === 'kept across a reload', 'read the draft back')

          // Sending it is the end of the draft: the next visit starts empty.
          again.submit()
          yield* until(() => again.state().draft === '', 'cleared the composer')
          yield* Effect.sleep('400 millis')
          expect(browser.stored(draftKey('a'))).toBeUndefined()
          again.stop()
        }),
      ),
    )
  }, 15_000)

  test('deleting the open session leaves the page blank and forgets it', async () => {
    stubTheBrowser()
    const host = makeHost('a')
    const sessionRoot = await mkdtemp(join(tmpdir(), 'jzh-store-delete-'))
    await mkdir(join(sessionRoot, 'a'), { recursive: true })
    const base = makeSettings()
    const settings: FakeSettings = {
      ...base,
      port: {
        ...base.port,
        read: () =>
          Effect.succeed({
            model: 'stub/model',
            effort: '',
            efforts: ['low', 'high'],
            settingsPath: '/work/settings.yml',
            cwd: '/work',
            sessionRoot,
          }),
      },
    }
    await Effect.runPromise(
      withStore(
        host,
        (store) =>
          Effect.gen(function* () {
            yield* until(() => store.state().opened.includes('a'), 'listed the open session')
            store.act('a', { kind: 'delete' })
            yield* until(() => store.state().sessionId === '', 'stood on a blank page')
            yield* until(() => !store.state().opened.includes('a'), 'forgot the deleted session')
            // The page stays on the blank one and says nothing went wrong.
            yield* Effect.sleep('600 millis')
            expect(store.state().sessionId).toBe('')
            expect(store.state().problem).toBe('')
            const gone = yield* Effect.promise(async () => {
              try {
                await stat(join(sessionRoot, 'a'))
                return false
              } catch {
                return true
              }
            })
            expect(gone).toBe(true)
          }),
        { settings },
      ).pipe(
        Effect.ensuring(Effect.promise(() => rm(sessionRoot, { recursive: true, force: true }))),
      ),
    )
  }, 15_000)
})
