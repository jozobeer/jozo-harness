import { describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import type { UiCommand, UiEvent, UiHost } from '@jozo-harness/ui-protocol'
import { WebSocket } from 'ws'
import { Deferred, Effect, Exit, Fiber, Option, Queue, Stream, type Scope } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  serveWeb,
  WebError,
  type OpenSession,
  type SessionFactory,
  type SettingsPort,
  type SettingsView,
  type WorkspacesPort,
} from '../src/server/index.ts'
import {
  type CommandView,
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
  readonly commandList: () => ReadonlyArray<CommandView>
  readonly runState: () => RunStateView
  readonly jobOutput: (id: string) => Effect.Effect<JobDetailView, WebError>
  readonly stopJob: (id: string) => Effect.Effect<void, WebError>
  readonly stopSubagent: (id: string) => Effect.Effect<void, WebError>
  /** The children a page stopped, in the order it asked. */
  readonly stopped: Array<string>
  readonly commands: Array<UiCommand>
  /** Broadcasts one event to every tab, like the real host does. */
  readonly publish: (event: UiEvent) => void
}

/** A host as the run holds it: working puts a job and a child agent in its state. */
const makeHost = (id: string, cwd = '/work', working = true): FakeHost => {
  const commands: Array<UiCommand> = []
  const stopped: Array<string> = []
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
    summary: { id, cwd, createdAt: 1, updatedAt: 1, title: '' },
    commandList: () => [
      { name: 'help', summary: 'list the commands this session answers', kind: 'command' },
      { name: 'status', summary: 'where this session stands', kind: 'command' },
    ],
    runState: () => ({
      goal: { objective: 'ship the UI', phase: 'active', rounds: 2, maxRounds: 8 },
      schedules: [
        {
          id: 's-1',
          when: 'every 60s',
          title: 'check the build',
          prompt: 'run pnpm run check',
          lastFiredAt: 0,
        },
      ],
      jobs: working
        ? [
            {
              id: 'j-1',
              command: 'sleep 5',
              running: true,
              startedAt: 1_700_000_000_000,
              tail: 'still going',
            },
          ]
        : [],
      subagents: working
        ? [{ id: 'child-1', status: 'running', startedAt: 1_700_000_000_000 }]
        : [],
      todos: [],
      todoCounts: { pending: 0, inProgress: 0, completed: 0 },
      skills: [],
      promptSections: [],
      queued: working ? ['one more thing'] : [],
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
    stopSubagent: (childId) =>
      childId === 'child-1'
        ? Effect.sync(() => {
            stopped.push(childId)
          })
        : Effect.fail(new WebError({ message: 'the subagent is not running' })),
    stopped,
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
  readonly initialClose: () => Effect.Effect<void>
  readonly factory: SessionFactory
  readonly hosts: Map<string, FakeHost>
  /** The boot sessions the server released, in the order it asked. */
  readonly closed: Array<string>
}

/** The sessions one fake store holds: the boot one, plus whatever a page opens. */
const makeWeb = (initialId: string, cwd = '/work', working = true): FakeWeb => {
  const first = makeHost(initialId, cwd, working)
  const hosts = new Map<string, FakeHost>([[initialId, first]])
  const closed: Array<string> = []
  return {
    hosts,
    closed,
    initial: {
      summary: first.summary,
      host: first.host,
      commands: first.commandList,
      runState: first.runState,
      jobOutput: first.jobOutput,
      stopJob: first.stopJob,
      stopSubagent: first.stopSubagent,
      busy: () => working,
    },
    initialClose: () =>
      Effect.sync(() => {
        closed.push(initialId)
      }),
    factory: {
      list: () => Effect.succeed([...hosts.values()].map((fake) => fake.summary)),
      open: (id, cwd) =>
        Effect.sync(() => {
          const made = id ?? 'new-' + String(hosts.size + 1)
          const known = hosts.get(made)
          if (known !== undefined) {
            return {
              summary: known.summary,
              host: known.host,
              commands: known.commandList,
              runState: known.runState,
              jobOutput: known.jobOutput,
              stopJob: known.stopJob,
              stopSubagent: known.stopSubagent,
              busy: () => working,
            }
          }
          const fresh = makeHost(made, cwd, working)
          hosts.set(made, fresh)
          return {
            summary: fresh.summary,
            host: fresh.host,
            commands: fresh.commandList,
            runState: fresh.runState,
            jobOutput: fresh.jobOutput,
            stopJob: fresh.stopJob,
            stopSubagent: fresh.stopSubagent,
            busy: () => working,
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
  readonly token: string
  readonly wsUrl: string
  readonly stop: Deferred.Deferred<void>
}

const settingsView: SettingsView = {
  model: 'stub/model',
  effort: '',
  efforts: [],
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
      setEffort: () => Effect.void,
    },
  }
}

const makeWorkspaces = (): { readonly port: WorkspacesPort; readonly added: Array<string> } => {
  const added: Array<string> = []
  return {
    added,
    port: {
      list: () =>
        Effect.succeed({
          cwd: '/work',
          items: [
            { cwd: '/work/other', lastUsedAt: 20 },
            { cwd: '/work', lastUsedAt: 0 },
          ],
        }),
      add: (cwd) =>
        cwd === '/missing'
          ? Effect.fail(new WebError({ message: 'no such directory' }))
          : Effect.sync(() => {
              added.push(cwd)
            }),
      browse: (path) =>
        path === '/forbidden'
          ? Effect.fail(new WebError({ message: 'cannot read this directory' }))
          : Effect.succeed({
              path: path === '' ? '/work' : path,
              parent: '/',
              items: ['/work/other'],
            }),
    },
  }
}

const start = (
  staticRoot: string,
  web: FakeWeb,
  settings: ReturnType<typeof makeSettings>,
  workspaces: ReturnType<typeof makeWorkspaces> = makeWorkspaces(),
): Effect.Effect<Started, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<string>()
    const stop = yield* Deferred.make<void>()
    yield* Effect.forkScoped(
      serveWeb({
        initial: { session: web.initial, close: web.initialClose },
        factory: web.factory,
        settings: settings.port,
        workspaces: workspaces.port,
        commands: web.initial.commands,
        port: 0,
        staticRoot,
        onReady: (url) => {
          void Effect.runSync(Deferred.succeed(ready, url))
        },
        interrupt: Deferred.await(stop),
      }),
    )
    const page = new URL(yield* Deferred.await(ready))
    const token = page.searchParams.get('token')
    if (token === null) throw new Error('the server reported no token')
    return {
      origin: page.origin,
      token,
      wsUrl: 'ws://' + page.host + '/ui?token=' + token,
      stop,
    }
  })

/** What one socket attempt got: an open, or the status the handshake was refused with. */
interface Attempt {
  readonly opened: boolean
  readonly status: number
}

/** Tries one socket with the headers a browser would or would not send. */
const attemptSocket = (
  url: string,
  options: { readonly origin?: string; readonly headers?: Record<string, string> } = {},
): Promise<Attempt> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url, {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    })
    socket.once('open', () => {
      socket.close()
      resolve({ opened: true, status: 101 })
    })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve({ opened: false, status: response.statusCode ?? 0 })
    })
    socket.once('error', () => resolve({ opened: false, status: 0 }))
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
          const wsUrl = started.wsUrl

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
          const wsUrl = started.wsUrl
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
          const wsUrl = started.wsUrl
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

  test('a page opens a session in the workspace it names, and resuming keeps the header one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-cwd-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()
    const workspaces = makeWorkspaces()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings, workspaces)
          const wsUrl = started.wsUrl
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const offered = yield* client.workspaces()
            const made = yield* client.open({ cwd: '/elsewhere' })
            // A resume ignores the workspace the page named: the header is the session's.
            const resumed = yield* client.open({ sessionId: made.id, cwd: '/work' })
            const added = yield* client.addWorkspace({ cwd: '/elsewhere' })
            const refused = yield* client
              .addWorkspace({ cwd: '/missing' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const browsed = yield* client.browseDirectories({ path: '/work' })
            const started = yield* client.browseDirectories({ path: '' })
            const browseRefused = yield* client
              .browseDirectories({ path: '/forbidden' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { offered, made, resumed, added, refused, browsed, started, browseRefused }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.offered).toEqual({
      cwd: '/work',
      items: [
        { cwd: '/work/other', lastUsedAt: 20 },
        { cwd: '/work', lastUsedAt: 0 },
      ],
    })
    expect(observed.made.cwd).toBe('/elsewhere')
    // The session keeps where it was created, whatever the page asks for now.
    expect(observed.resumed.cwd).toBe('/elsewhere')
    expect(observed.added).toBe(true)
    expect(workspaces.added).toEqual(['/elsewhere'])
    expect(observed.refused).toBe('no such directory')
    expect(observed.browsed).toEqual({
      path: '/work',
      parent: '/',
      items: ['/work/other'],
    })
    // A blank path is the dialog opening on the run's own folder.
    expect(observed.started.path).toBe('/work')
    expect(observed.browseRefused).toBe('cannot read this directory')
    await rm(root, { recursive: true, force: true })
  })

  test('a page reads the files of the session cwd, and the walk keeps .gitignore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-files-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    await writeFileDeep(join(root, 'apps/web/client-solid/components/composer.tsx'), 'export {}')
    await writeFileDeep(join(root, 'ignored/comp.ts'), 'export {}')
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    const web = makeWeb('a', root)
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = started.wsUrl
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const files = yield* client.files({ sessionId: 'a', query: 'comp' })
            const empty = yield* client.files({ sessionId: 'a', query: '  ' })
            const refused = yield* client
              .files({ sessionId: 'gone', query: 'comp' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { files, empty, refused }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.files).toContain('apps/web/client-solid/components/composer.tsx')
    expect(observed.files).not.toContain('ignored/comp.ts')
    expect(observed.empty).toEqual([])
    expect(observed.refused).toBe('the session is not open')
    await rm(root, { recursive: true, force: true })
  })

  test('a page reads the branch its session workspace stands on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-branch-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-branch-work-'))
    const git = (...args: ReadonlyArray<string>): void => {
      execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' })
    }
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'init', '-q')
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'first',
    )
    git('checkout', '-q', '-b', 'status-bar')
    const web = makeWeb('a', workspace)
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = started.wsUrl
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const branch = yield* client.branch({ sessionId: 'a' })
            // The blank page has no workspace yet, and an unknown session is refused.
            const blank = yield* client.branch({ sessionId: '' })
            const refused = yield* client
              .branch({ sessionId: 'gone' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { branch, blank, refused }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.branch).toBe('status-bar')
    expect(observed.blank).toBeNull()
    expect(observed.refused).toBe('the session is not open')
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  test('the row menu deletes an open session, and the page lets go of it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-menu-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const sessionRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-web-menu-logs-'))
    await mkdir(join(sessionRoot, 'a'), { recursive: true })
    const web = makeWeb('a', '/work', false)
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
          const wsUrl = started.wsUrl
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
            const deleted = yield* client.sessionAction({
              sessionId: 'a',
              action: { kind: 'delete' },
            })
            const after = yield* client.sessions()
            const gone = yield* Effect.promise(async () => {
              try {
                await stat(join(sessionRoot, 'a'))
                return false
              } catch {
                return true
              }
            })
            return { pinned, listed, opened, deleted, after, gone }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.pinned).toBe(true)
    expect(observed.listed.items[0]).toMatchObject({ title: 'named by hand', pinned: true })
    expect(observed.listed.opened).toEqual(['a'])
    expect(observed.opened).toMatchObject({ title: 'named by hand', pinned: true })
    expect(observed.deleted).toBe(true)
    // The log is gone from disk, and the page no longer lists it as open.
    expect(observed.gone).toBe(true)
    expect(observed.after.opened).toEqual([])
    expect(observed.after.initial).toBe('')
    // The core was released before the directory went away.
    expect(web.closed).toEqual(['a'])
    await rm(root, { recursive: true, force: true })
    await rm(sessionRoot, { recursive: true, force: true })
  })

  test('the row menu refuses to delete a session that is still working, and says what to stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-menu-busy-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const sessionRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-web-menu-busy-logs-'))
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
          const wsUrl = started.wsUrl
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            yield* client.open({ sessionId: 'a' })
            const refused = yield* client
              .sessionAction({ sessionId: 'a', action: { kind: 'delete' } })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const after = yield* client.sessions()
            const stillThere = yield* Effect.promise(async () => {
              try {
                await stat(join(sessionRoot, 'a'))
                return true
              } catch {
                return false
              }
            })
            return { refused, after, stillThere }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.refused).toBe(
      'stop the running turn, job, or subagent, then delete the session',
    )
    // Nothing was closed or removed: the page still holds the working session.
    expect(observed.after.opened).toEqual(['a'])
    expect(observed.stillThere).toBe(true)
    expect(web.closed).toEqual([])
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
          const wsUrl = started.wsUrl
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const running = yield* client.state({ sessionId: 'a' })
            const refused = yield* client
              .state({ sessionId: 'gone' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const detail = yield* client.jobDetail({ sessionId: 'a', id: 'j-1' })
            const stopped = yield* client.stopJob({ sessionId: 'a', id: 'j-1' })
            const childStopped = yield* client.stopSubagent({ sessionId: 'a', id: 'child-1' })
            const unknownChild = yield* client
              .stopSubagent({ sessionId: 'a', id: 'child-9' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const unknownJob = yield* client
              .jobDetail({ sessionId: 'a', id: 'j-9' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { running, refused, detail, stopped, childStopped, unknownChild, unknownJob }
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
    expect(observed.running.jobs).toEqual([
      {
        id: 'j-1',
        command: 'sleep 5',
        running: true,
        startedAt: 1_700_000_000_000,
        tail: 'still going',
      },
    ])
    expect(observed.running.subagents).toEqual([
      { id: 'child-1', status: 'running', startedAt: 1_700_000_000_000 },
    ])
    expect(observed.running.queued).toEqual(['one more thing'])
    expect(observed.detail).toEqual({
      id: 'j-1',
      command: 'sleep 5',
      running: true,
      output: 'still going',
    })
    expect(observed.stopped).toBe(true)
    expect(observed.childStopped).toBe(true)
    expect(observed.unknownChild).toBe('the subagent is not running')
    expect(observed.unknownJob).toBe('no such job')
    expect(observed.refused).toBe('the session is not open')
    await rm(root, { recursive: true, force: true })
  })

  test('the page asks what a session can be told, and the blank page the list the run holds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-commands-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = started.wsUrl
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const listed = yield* client.commands({ sessionId: 'a' })
            const blank = yield* client.commands({ sessionId: '' })
            const refused = yield* client
              .commands({ sessionId: 'gone' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { listed, blank, refused }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.listed.map((one) => one.name)).toEqual(['help', 'status'])
    expect(observed.blank).toEqual([
      { name: 'help', summary: 'list the commands this session answers', kind: 'command' },
      { name: 'status', summary: 'where this session stands', kind: 'command' },
    ])
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
          const wsUrl = started.wsUrl
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const view = yield* client.settings()
            const models = yield* client.models()
            // The sheet's pick is the one the file keeps for the runs after this one.
            const written = yield* client.setModel({ model: 'stub/other', remember: true })
            // The seat's pick is the choice of this run alone, so nothing is written.
            const chosen = yield* client.setModel({ model: 'stub/third', remember: false })
            // The effort a blank page picks is the run's choice too.
            const switched = yield* client.setEffort({ effort: 'high' })
            const refused = yield* client
              .setModel({ model: '', remember: true })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { view, models, written, chosen, switched, refused }
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
    expect(observed.switched).toBe(true)
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
      setEffort: () => Effect.fail(new WebError({ message: 'no writing here' })),
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, { port: failing, wrote: [] })
          const wsUrl = started.wsUrl
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

  test('the ready url carries a token the socket must repeat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-root-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const socket = 'ws://' + new URL(started.origin).host + '/ui'
          const noToken = yield* Effect.promise(() => attemptSocket(socket))
          const wrongToken = yield* Effect.promise(() =>
            attemptSocket(socket + '?token=' + 'x'.repeat(started.token.length)),
          )
          const rightToken = yield* Effect.promise(() => attemptSocket(started.wsUrl))
          const foreignOrigin = yield* Effect.promise(() =>
            attemptSocket(started.wsUrl, { origin: 'http://evil.example' }),
          )
          const pageOrigin = yield* Effect.promise(() =>
            attemptSocket(started.wsUrl, { origin: started.origin }),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return {
            token: started.token,
            noToken,
            wrongToken,
            rightToken,
            foreignOrigin,
            pageOrigin,
          }
        }),
      ),
    )

    expect(observed.token).toMatch(/^[0-9a-f]{64}$/)
    expect(observed.noToken).toEqual({ opened: false, status: 401 })
    expect(observed.wrongToken).toEqual({ opened: false, status: 401 })
    expect(observed.rightToken.opened).toBe(true)
    expect(observed.foreignOrigin).toEqual({ opened: false, status: 403 })
    expect(observed.pageOrigin.opened).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test('a request from a foreign host is refused before it is served', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-root-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const port = Number(new URL(started.origin).port)
          const status = yield* Effect.promise(
            () =>
              new Promise<number>((resolve, reject) => {
                const asked = request(
                  {
                    hostname: '127.0.0.1',
                    port,
                    path: '/',
                    headers: { host: 'evil.example' },
                  },
                  (response) => {
                    response.resume()
                    resolve(response.statusCode ?? 0)
                  },
                )
                asked.on('error', reject)
                asked.end()
              }),
          )
          const socket = yield* Effect.promise(() =>
            attemptSocket(started.wsUrl, { headers: { host: 'evil.example' } }),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return { status, socket }
        }),
      ),
    )

    expect(observed.status).toBe(403)
    expect(observed.socket).toEqual({ opened: false, status: 403 })
    await rm(root, { recursive: true, force: true })
  })
})
