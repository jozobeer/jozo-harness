import { describe, expect, test } from 'vitest'
import type { UiCommand, UiEvent, UiHost } from '@jozo-harness/ui-protocol'
import { Deferred, Effect, Exit, Fiber, Option, Queue, Stream, type Scope } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  serveWeb,
  WebError,
  type OpenSession,
  type SessionFactory,
  type SettingsPort,
  type SettingsView,
} from '../src/server/index.ts'
import {
  type JobDetailView,
  type RunStateView,
  type SessionSummary,
  UiRpcs,
  withoutServices,
} from '../src/shared/rpc.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

interface FakeHost {
  readonly summary: SessionSummary
  readonly host: UiHost
  readonly runState: () => RunStateView
  readonly jobOutput: (id: string) => Effect.Effect<JobDetailView, WebError>
  readonly stopJob: (id: string) => Effect.Effect<void, WebError>
  readonly commands: Array<UiCommand>
  /** Broadcasts one event to every tab, like the real host does. */
  readonly publish: (event: UiEvent) => void
}

const makeHost = (id: string): FakeHost => {
  const commands: Array<UiCommand> = []
  const subscribers = new Set<Queue.Queue<UiEvent>>()
  const publish = (event: UiEvent): void => {
    for (const queue of subscribers.values().toArray()) Queue.offerUnsafe(queue, event)
  }
  const events = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<UiEvent>()
        subscribers.add(queue)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            subscribers.delete(queue)
          }),
        )
        return Stream.fromQueue(queue)
      }),
    ),
  )
  const record = (command: UiCommand): Effect.Effect<void> =>
    Effect.sync(() => {
      commands.push(command)
    })
  return {
    summary: { id, cwd: '/work', createdAt: 1, updatedAt: 1, title: '' },
    runState: () => ({
      goal: { objective: 'ship the UI', phase: 'active', rounds: 2, maxRounds: 8 },
      schedules: [{ id: 's-1', when: 'every 60s', prompt: 'check the build', lastFiredAt: 0 }],
      jobs: [{ id: 'j-1', command: 'sleep 5', running: true }],
      todos: [],
      todoCounts: { pending: 0, inProgress: 0, completed: 0 },
      skills: [],
      promptSections: [],
      queued: ['one more thing'],
      model: 'stub/model',
      effort: 'high',
      efforts: ['low', 'high'],
    }),
    jobOutput: (jobId) =>
      jobId === 'j-1'
        ? Effect.succeed({ id: 'j-1', command: 'sleep 5', running: true, output: 'still going' })
        : Effect.fail(new WebError({ message: 'no such job' })),
    stopJob: (jobId) =>
      jobId === 'j-1' ? Effect.void : Effect.fail(new WebError({ message: 'no such job' })),
    commands,
    publish,
    host: {
      events,
      submit: (text) => record({ kind: 'submit', text }),
      approve: (callId, approved) => record({ kind: 'approve', callId, approved }),
      answer: (id2, answer) => record({ kind: 'answer', id: id2, answer }),
      cancel: () => record({ kind: 'cancel' }),
      setEffort: (effort) => record({ kind: 'effort', effort }),
      setModel: (model) => record({ kind: 'model', model }),
      answerApproval: () => Effect.succeed(true),
      answerAsk: () => Effect.succeed(''),
    },
  }
}

interface FakeWeb {
  readonly initial: OpenSession
  readonly factory: SessionFactory
  readonly hosts: Map<string, FakeHost>
}

/** The sessions one fake store holds: the boot one, plus whatever a page opens. */
const makeWeb = (initialId: string): FakeWeb => {
  const first = makeHost(initialId)
  const hosts = new Map<string, FakeHost>([[initialId, first]])
  return {
    hosts,
    initial: {
      summary: first.summary,
      host: first.host,
      runState: first.runState,
      jobOutput: first.jobOutput,
      stopJob: first.stopJob,
    },
    factory: {
      list: () => Effect.succeed([...hosts.values()].map((fake) => fake.summary)),
      open: (id) =>
        Effect.sync(() => {
          const made = id ?? 'new-' + String(hosts.size + 1)
          const known = hosts.get(made)
          if (known !== undefined) {
            return {
              summary: known.summary,
              host: known.host,
              runState: known.runState,
              jobOutput: known.jobOutput,
              stopJob: known.stopJob,
            }
          }
          const fresh = makeHost(made)
          hosts.set(made, fresh)
          return {
            summary: fresh.summary,
            host: fresh.host,
            runState: fresh.runState,
            jobOutput: fresh.jobOutput,
            stopJob: fresh.stopJob,
          }
        }),
    },
  }
}

const clientLayers =
  (wsUrl: string) =>
  <A, E>(self: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
    self.pipe(
      Effect.provide(RpcClient.layerProtocolSocket()),
      Effect.provide(Socket.layerWebSocket(wsUrl)),
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
      Effect.provide(RpcSerialization.layerJson),
    ) as Effect.Effect<A, E>

interface Started {
  readonly origin: string
  readonly stop: Deferred.Deferred<void>
}

const settingsView: SettingsView = {
  model: 'stub/model',
  effort: '',
  settingsPath: '/work/settings.yml',
  cwd: '/work',
  sessionRoot: '/work/sessions',
}

/** A settings file the page may read and write, kept only in memory. */
const makeSettings = (): { readonly port: SettingsPort; readonly wrote: Array<string> } => {
  const wrote: Array<string> = []
  return {
    wrote,
    port: {
      read: () => Effect.succeed(settingsView),
      models: () => Effect.succeed(['stub/model', 'stub/other']),
      setModel: (model, remember) =>
        model === ''
          ? Effect.fail(new WebError({ message: 'a model route cannot be empty' }))
          : Effect.sync(() => {
              // What the settings file keeps is the write the page asked for.
              if (remember) wrote.push(model)
            }),
    },
  }
}

const start = (
  staticRoot: string,
  web: FakeWeb,
  settings: ReturnType<typeof makeSettings>,
): Effect.Effect<Started, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<string>()
    const stop = yield* Deferred.make<void>()
    yield* Effect.forkScoped(
      serveWeb({
        initial: web.initial,
        factory: web.factory,
        settings: settings.port,
        port: 0,
        staticRoot,
        onReady: (url) => {
          void Effect.runSync(Deferred.succeed(ready, url))
        },
        interrupt: Deferred.await(stop),
      }),
    )
    return { origin: (yield* Deferred.await(ready)).replace(/\/$/, ''), stop }
  })

const tick = (): UiEvent => ({
  kind: 'session',
  event: { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
})

describe('the web transport', () => {
  test('a browser client speaks commands and events over one socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'jozo-harness-web-outside-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    await writeFileDeep(join(outside, 'secret.txt'), 'secret')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = 'ws://' + started.origin.replace(/^http:\/\//, '') + '/ui'

          // The client layers own a scoped socket: they must wrap every call.
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const accepted = yield* client.command({
              sessionId: 'a',
              command: { kind: 'submit', text: 'hello' },
            })
            const collected = yield* Effect.forkScoped(
              client.events({ sessionId: 'a' }).pipe(Stream.take(1), Stream.runCollect),
            )
            yield* Effect.sleep(50)
            web.hosts.get('a')?.publish(tick())
            return { accepted, received: [...(yield* Fiber.join(collected))][0] }
          }).pipe(clientLayers(wsUrl))
          const { accepted, received } = yield* withoutServices(useClient)

          const home = yield* Effect.promise(() => fetch(started.origin + '/'))
          const missing = yield* Effect.promise(() => fetch(started.origin + '/nope.js'))
          const traversal = yield* Effect.promise(() =>
            fetch(started.origin + '/%2e%2e/secret.txt'),
          )
          const homeText = yield* Effect.promise(() => home.text())
          yield* Deferred.succeed(started.stop, undefined)

          return {
            accepted,
            received,
            home: homeText,
            homeStatus: home.status,
            missingStatus: missing.status,
            traversalStatus: traversal.status,
            commands: web.hosts.get('a')?.commands ?? [],
          }
        }),
      ),
    )

    expect(observed.accepted).toBe(true)
    expect(observed.commands).toEqual([{ kind: 'submit', text: 'hello' }])
    expect(observed.received?.kind).toBe('session')
    expect(observed.homeStatus).toBe(200)
    expect(observed.home).toContain('<h1>jozo-harness</h1>')
    expect(observed.missingStatus).toBe(404)
    expect(observed.traversalStatus).toBe(404)
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  test('two tabs subscribe to the same conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-tabs-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const counts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = 'ws://' + started.origin.replace(/^http:\/\//, '') + '/ui'
          const useTabs = Effect.gen(function* () {
            const one = yield* RpcClient.make(UiRpcs)
            const two = yield* RpcClient.make(UiRpcs)
            const first = yield* Effect.forkScoped(
              one.events({ sessionId: 'a' }).pipe(Stream.take(1), Stream.runCollect),
            )
            const second = yield* Effect.forkScoped(
              two.events({ sessionId: 'a' }).pipe(Stream.take(1), Stream.runCollect),
            )
            yield* Effect.sleep(50)
            web.hosts.get('a')?.publish(tick())
            return {
              first: [...(yield* Fiber.join(first))].length,
              second: [...(yield* Fiber.join(second))].length,
            }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useTabs)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(counts).toEqual({ first: 1, second: 1 })
    await rm(root, { recursive: true, force: true })
  })

  test('the page lists the store, opens one more, and each id keeps its own conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-sessions-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = 'ws://' + started.origin.replace(/^http:\/\//, '') + '/ui'
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const listed = yield* client.sessions()
            const again = yield* client.open({ sessionId: 'a' })
            const made = yield* client.open({})
            const accepted = yield* client.command({
              sessionId: made.id,
              command: { kind: 'cancel' },
            })
            // A listener on 'a' that never hears the new session's event runs out of time.
            const watching = yield* Effect.forkScoped(
              client
                .events({ sessionId: 'a' })
                .pipe(Stream.take(1), Stream.runCollect, Effect.timeoutOption('200 millis')),
            )
            const unknown = yield* client
              .events({ sessionId: 'gone' })
              .pipe(Stream.take(1), Stream.runCollect, Effect.exit)
            yield* Effect.sleep(50)
            web.hosts.get(made.id)?.publish(tick())
            const heard = yield* Fiber.join(watching)
            return {
              listed,
              again: again.id,
              made: made.id,
              accepted,
              silent: Option.isNone(heard),
              refused: Exit.isFailure(unknown),
              onNew: web.hosts.get(made.id)?.commands ?? [],
            }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.listed).toEqual({
      initial: 'a',
      items: [
        {
          id: 'a',
          cwd: '/work',
          createdAt: 1,
          updatedAt: 1,
          title: '',
          pinned: false,
          archived: false,
        },
      ],
      opened: ['a'],
    })
    expect(observed.again).toBe('a')
    expect(observed.made).toBe('new-2')
    expect(observed.accepted).toBe(true)
    expect(observed.onNew).toEqual([{ kind: 'cancel' }])
    expect(observed.silent).toBe(true)
    expect(observed.refused).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test('the row menu renames a session, and refuses to delete one that is open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-menu-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const sessionRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-web-menu-logs-'))
    await mkdir(join(sessionRoot, 'a'), { recursive: true })
    const web = makeWeb('a')
    const base = makeSettings()
    const settings = {
      ...base,
      port: {
        ...base.port,
        read: () => Effect.succeed({ ...settingsView, sessionRoot }),
      } satisfies SettingsPort,
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = 'ws://' + started.origin.replace(/^http:\/\//, '') + '/ui'
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            yield* client.sessionAction({
              sessionId: 'a',
              action: { kind: 'rename', title: 'named by hand' },
            })
            const pinned = yield* client.sessionAction({
              sessionId: 'a',
              action: { kind: 'pin', pinned: true },
            })
            const listed = yield* client.sessions()
            const opened = yield* client.open({ sessionId: 'a' })
            const refused = yield* client
              .sessionAction({ sessionId: 'a', action: { kind: 'delete' } })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { pinned, listed, opened, refused }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.pinned).toBe(true)
    expect(observed.listed.items[0]).toMatchObject({ title: 'named by hand', pinned: true })
    expect(observed.opened).toMatchObject({ title: 'named by hand', pinned: true })
    expect(observed.refused).toBe('stop the session before deleting it')
    await rm(root, { recursive: true, force: true })
    await rm(sessionRoot, { recursive: true, force: true })
  })

  test('the page asks a session what it is working toward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-state-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = 'ws://' + started.origin.replace(/^http:\/\//, '') + '/ui'
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const running = yield* client.state({ sessionId: 'a' })
            const refused = yield* client
              .state({ sessionId: 'gone' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const detail = yield* client.jobDetail({ sessionId: 'a', id: 'j-1' })
            const stopped = yield* client.stopJob({ sessionId: 'a', id: 'j-1' })
            const unknownJob = yield* client
              .jobDetail({ sessionId: 'a', id: 'j-9' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { running, refused, detail, stopped, unknownJob }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.running.goal?.objective).toBe('ship the UI')
    expect(observed.running.goal?.rounds).toBe(2)
    expect(observed.running.schedules[0]?.when).toBe('every 60s')
    expect(observed.running.jobs).toEqual([{ id: 'j-1', command: 'sleep 5', running: true }])
    expect(observed.running.queued).toEqual(['one more thing'])
    expect(observed.detail).toEqual({
      id: 'j-1',
      command: 'sleep 5',
      running: true,
      output: 'still going',
    })
    expect(observed.stopped).toBe(true)
    expect(observed.unknownJob).toBe('no such job')
    expect(observed.refused).toBe('the session is not open')
    await rm(root, { recursive: true, force: true })
  })

  test('the page reads the settings and writes a model through them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-settings-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = 'ws://' + started.origin.replace(/^http:\/\//, '') + '/ui'
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const view = yield* client.settings()
            const models = yield* client.models()
            // The sheet's pick is the one the file keeps for the runs after this one.
            const written = yield* client.setModel({ model: 'stub/other', remember: true })
            // The seat's pick is the choice of this run alone, so nothing is written.
            const chosen = yield* client.setModel({ model: 'stub/third', remember: false })
            const refused = yield* client
              .setModel({ model: '', remember: true })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { view, models, written, chosen, refused }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.view).toEqual(settingsView)
    expect(observed.models).toEqual(['stub/model', 'stub/other'])
    expect(observed.written).toBe(true)
    expect(observed.chosen).toBe(true)
    // The route the page asked to keep is the one the file holds.
    expect(settings.wrote).toEqual(['stub/other'])
    expect(observed.refused).toBe('a model route cannot be empty')
    await rm(root, { recursive: true, force: true })
  })

  test('a missing job and unreadable settings come back as the errors the page shows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-errors-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const failing: SettingsPort = {
      read: () => Effect.fail(new WebError({ message: 'no settings here' })),
      models: () => Effect.fail(new WebError({ message: 'no models here' })),
      setModel: () => Effect.fail(new WebError({ message: 'no writing here' })),
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, { port: failing, wrote: [] })
          const wsUrl = 'ws://' + started.origin.replace(/^http:\/\//, '') + '/ui'
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const stopped = yield* client
              .stopJob({ sessionId: 'a', id: 'nope' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const settings = yield* client
              .settings()
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const models = yield* client
              .models()
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { stopped, settings, models }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.stopped).toBe('no such job')
    expect(observed.settings).toBe('no settings here')
    expect(observed.models).toBe('no models here')
    await rm(root, { recursive: true, force: true })
  })
})
