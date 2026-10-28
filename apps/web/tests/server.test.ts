import { describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import { makeArtifactTool, makeScheduleStore } from '@jozo-harness/tools-tier1'
import type { SessionEvent, UiCommand, UiEvent, UiHost } from '@jozo-harness/ui-protocol'
import { WebSocket } from 'ws'
import { Deferred, Effect, Exit, Fiber, Option, Queue, Stream, type Scope } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { networkInterfaces, tmpdir } from 'node:os'
import {
  serveWeb,
  WebError,
  type OpenSession,
  type PluginChangeAnswer,
  type PluginChangeRequest,
  type PluginsPort,
  type PluginsView,
  type PublicOrigin,
  type ReadyUrls,
  type ServeWebOptions,
  type SessionFactory,
  type EditableSettingsView,
  type RunSettingsInput,
  type SettingsPort,
  type SubagentMessageView,
  type SettingsView,
  type TailnetAddresses,
  type WebhookRule,
  type OpenInAppPort,
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

/** One artifact as the list route promises it. */
interface ArtifactEntry {
  readonly name: string
  readonly path: string
  readonly bytes: number
  readonly updatedAt: string
}

const isArtifactEntry = (value: unknown): value is ArtifactEntry =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'path' in value &&
  typeof value.path === 'string' &&
  'bytes' in value &&
  typeof value.bytes === 'number' &&
  'updatedAt' in value &&
  typeof value.updatedAt === 'string'

/** Parses the list the route returns, refusing a shape the page could not rely on. */
const artifactEntries = (text: string): ReadonlyArray<ArtifactEntry> => {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed) || !parsed.every(isArtifactEntry)) {
    throw new Error('the artifact list is malformed')
  }
  return parsed
}

interface FakeHost {
  readonly summary: SessionSummary
  readonly host: UiHost
  readonly commandList: () => ReadonlyArray<CommandView>
  readonly runState: () => RunStateView
  readonly jobOutput: (id: string) => Effect.Effect<JobDetailView, WebError>
  readonly stopJob: (id: string) => Effect.Effect<void, WebError>
  readonly stopSubagent: (id: string) => Effect.Effect<void, WebError>
  readonly messageSubagent: (
    id: string,
    message: string,
  ) => Effect.Effect<SubagentMessageView, WebError>
  /** The children a page stopped, in the order it asked. */
  readonly stopped: Array<string>
  /** The follow-ups a page sent, in the order it asked. */
  readonly messaged: Array<{ readonly id: string; readonly message: string }>
  readonly commands: Array<UiCommand>
  /** Broadcasts one event to every tab, like the real host does. */
  readonly publish: (event: UiEvent) => void
}

/** A host as the run holds it: working puts a job and a child agent in its state. */
const makeHost = (id: string, cwd = '/work', working = true): FakeHost => {
  const commands: Array<UiCommand> = []
  const stopped: Array<string> = []
  const messaged: Array<{ readonly id: string; readonly message: string }> = []
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
  /** The log line one command leaves, so every page following the session sees it. */
  let written = 0
  const write = (type: string, data: unknown): void => {
    written += 1
    publish({
      kind: 'session',
      event: { seq: written, time: 1_700_000_000_000 + written, type, data },
    })
  }
  /** The one event a command leaves in the log; a core writes it once, for every reader. */
  const loggedBy = (command: UiCommand): { type: string; data: unknown } | undefined => {
    switch (command.kind) {
      case 'submit':
        return { type: 'user/message', data: { text: command.text, source: 'user' } }
      case 'approve':
        return {
          type: 'safety/approval/answered',
          data: { callId: command.callId, approved: command.approved },
        }
      case 'answer':
        return {
          type: 'interaction/ask/answered',
          data: { id: command.id, answer: command.answer },
        }
      case 'cancel':
        return { type: 'turn/end', data: { reason: { kind: 'cancelled' } } }
      default:
        return undefined
    }
  }
  const record = (command: UiCommand): Effect.Effect<void> =>
    Effect.sync(() => {
      commands.push(command)
      const logged = loggedBy(command)
      if (logged !== undefined) write(logged.type, logged.data)
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
        ? [
            {
              id: 'child-1',
              status: 'running',
              startedAt: 1_700_000_000_000,
              depth: 1,
              maxDepth: 2,
            },
          ]
        : [],
      todos: [],
      todoCounts: { pending: 0, inProgress: 0, completed: 0 },
      skills: [],
      promptSections: [],
      queued: working ? ['one more thing'] : [],
      steering: [],
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
    messageSubagent: (childId, message) =>
      childId === 'child-1'
        ? Effect.sync(() => {
            messaged.push({ id: childId, message })
            return { id: childId, queued: false }
          })
        : Effect.fail(new WebError({ message: 'the subagent is not running' })),
    stopped,
    messaged,
    commands,
    publish,
    host: {
      events,
      submit: (text, mode, quotes, references) =>
        record({
          kind: 'submit',
          text,
          ...(mode === undefined ? {} : { mode }),
          ...(quotes === undefined ? {} : { quotes }),
          ...(references === undefined ? {} : { references }),
        }),
      approve: (callId, approved) => record({ kind: 'approve', callId, approved }),
      answer: (id2, answer) => record({ kind: 'answer', id: id2, answer }),
      cancel: () => record({ kind: 'cancel' }),
      setEffort: (effort) => record({ kind: 'effort', effort }),
      setModel: (model) => record({ kind: 'model', model }),
      answerApproval: () => Effect.succeed(true),
      answerAsk: () => Effect.succeed(''),
      serveQuestions: () => Effect.succeed([]),
      rate: () => Effect.void,
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
  /** The events each created session started from. */
  readonly seeds: Array<ReadonlyArray<SessionEvent> | undefined>
  /** The log a fork reads, as the store would hand it back. */
  readonly log: Array<SessionEvent>
}

/** The sessions one fake store holds: the boot one, plus whatever a page opens. */
const makeWeb = (initialId: string, cwd = '/work', working = true): FakeWeb => {
  const first = makeHost(initialId, cwd, working)
  const hosts = new Map<string, FakeHost>([[initialId, first]])
  const closed: Array<string> = []
  const seeds: Array<ReadonlyArray<SessionEvent> | undefined> = []
  const log: Array<SessionEvent> = [
    { seq: 1, time: 1, type: 'user/message', data: { text: 'first ask', source: 'user' } },
    { seq: 2, time: 2, type: 'user/message', data: { text: 'second ask', source: 'user' } },
  ]
  return {
    hosts,
    closed,
    seeds,
    log,
    initial: {
      summary: first.summary,
      host: first.host,
      commands: first.commandList,
      runState: first.runState,
      jobOutput: first.jobOutput,
      stopJob: first.stopJob,
      stopSubagent: first.stopSubagent,
      messageSubagent: first.messageSubagent,
      busy: () => working,
    },
    initialClose: () =>
      Effect.sync(() => {
        closed.push(initialId)
      }),
    factory: {
      list: () => Effect.succeed([...hosts.values()].map((fake) => fake.summary)),
      read: () => Effect.succeed(log),
      open: (id, cwd, seed) =>
        Effect.sync(() => {
          seeds.push(seed)
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
              messageSubagent: known.messageSubagent,
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
            messageSubagent: fresh.messageSubagent,
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
  readonly localUrl: string
  readonly tailnetUrls: ReadonlyArray<string>
  readonly publicUrl: string | undefined
  readonly code: string
  readonly token: string
  readonly cookie: string
  readonly exchangeStatus: number
  readonly exchangeLocation: string | undefined
  readonly wsUrl: string
  readonly stop: Deferred.Deferred<void>
}

/** What one plain GET answered, keeping the headers a redirect test reads. */
interface HttpObservation {
  readonly status: number
  readonly location: string | undefined
  readonly setCookie: string | undefined
}

/** A non-loopback IPv4 this machine holds: the shape Tailscale reports for a tailnet. */
const localAddress = (): string => {
  const address = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)[0]
  if (address === undefined) throw new Error('this machine has no non-loopback IPv4 to bind')
  return address
}

/** One JSON round trip with a method and an optional cookie, as the owner's page makes it. */
interface HttpCall {
  readonly status: number
  readonly body: string
  readonly location: string | undefined
  readonly setCookie: string | undefined
}

const httpCall = (url: string, method: string, cookie?: string): Promise<HttpCall> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const asked = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        ...(cookie === undefined ? {} : { headers: { cookie } }),
      },
      (response) => {
        const chunks: Array<Buffer> = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const location = response.headers.location
          const setCookie = response.headers['set-cookie']?.[0]
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            location: typeof location === 'string' ? location : undefined,
            setCookie: typeof setCookie === 'string' ? setCookie : undefined,
          })
        })
      },
    )
    asked.on('error', reject)
    asked.end()
  })

/** One invitation as the share route answers it, checked before a test reads a field. */
interface SharedInvitation {
  readonly id: string
  readonly label: string
  readonly url: string
}

const sharedInvitation = (text: string): SharedInvitation => {
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('id' in parsed) ||
    typeof parsed.id !== 'string' ||
    !('label' in parsed) ||
    typeof parsed.label !== 'string' ||
    !('url' in parsed) ||
    typeof parsed.url !== 'string'
  ) {
    throw new Error('the share route answered a malformed invitation')
  }
  return { id: parsed.id, label: parsed.label, url: parsed.url }
}

/** Asks one URL the way a browser first opens the startup URL; `host` overrides its Host header. */
const httpGet = (url: string, host?: string): Promise<HttpObservation> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const asked = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        ...(host === undefined ? {} : { headers: { host } }),
      },
      (response) => {
        response.resume()
        const location = response.headers.location
        const setCookie = response.headers['set-cookie']?.[0]
        resolve({
          status: response.statusCode ?? 0,
          location: typeof location === 'string' ? location : undefined,
          setCookie: typeof setCookie === 'string' ? setCookie : undefined,
        })
      },
    )
    asked.on('error', reject)
    asked.end()
  })

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
      editable: () =>
        Effect.succeed({
          search: { keyName: 'BRAVE_API_KEY', keyPresent: false, source: 'no provider is named' },
          apiKeyRef: { ref: '', present: false, source: 'no reference is named' },
          bashTimeoutMs: { value: 120_000, source: 'the default' },
          maxParallelToolCalls: { value: 10, source: 'the default' },
          subagentDepth: { value: 1, source: 'the default' },
          delegateTools: [],
        }),
      saveEditable: () =>
        Effect.succeed({
          search: { keyName: 'BRAVE_API_KEY', keyPresent: false, source: 'no provider is named' },
          apiKeyRef: { ref: '', present: false, source: 'no reference is named' },
          bashTimeoutMs: { value: 120_000, source: 'the default' },
          maxParallelToolCalls: { value: 10, source: 'the default' },
          subagentDepth: { value: 1, source: 'the default' },
          delegateTools: [],
        }),
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
  /** The https origin a proxy would publish, when the test drives one. */
  publicUrl?: PublicOrigin,
  /** The tailnet addresses a detection would name, when the test drives one. */
  tailnet?: TailnetAddresses,
  /** The plugin route's port; a test that only lists rows may leave it empty. */
  plugins: PluginsPort = {
    view: () => ({ rows: [], catalog: [], failures: [] }),
    known: () => [],
    change: async () => ({ ok: true }),
  },
  /** The log read the session export route folds; tests that never export leave it empty. */
  readSessionEvents: ServeWebOptions['readSessionEvents'] = () => Effect.succeed([]),
  /** The rules the webhook route may start sessions from; empty refuses every /hooks/ path. */
  webhooks: ReadonlyArray<WebhookRule> = [],
  /** What the page may open the workspace with; absent keeps the route's no-app answer. */
  openInApp?: OpenInAppPort,
): Effect.Effect<Started, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<ReadyUrls>()
    const stop = yield* Deferred.make<void>()
    yield* Effect.forkScoped(
      serveWeb({
        initial: { session: web.initial, close: web.initialClose },
        factory: web.factory,
        settings: settings.port,
        readSessionEvents,
        schedules: makeScheduleStore(
          join(
            tmpdir(),
            'jzh-test-schedules-' + String(process.pid) + '-' + String(Math.random()).slice(2),
          ),
        ),
        workspaces: workspaces.port,
        ...(openInApp === undefined ? {} : { openInApp }),
        commands: web.initial.commands,
        plugins,
        ...(webhooks.length === 0 ? {} : { webhooks }),
        port: 0,
        staticRoot,
        ...(publicUrl === undefined ? {} : { publicUrl }),
        ...(tailnet === undefined ? {} : { tailnet }),
        onReady: (urls) => {
          void Effect.runSync(Deferred.succeed(ready, urls))
        },
        interrupt: Deferred.await(stop),
      }),
    )
    const urls = yield* Deferred.await(ready)
    const page = new URL(urls.local)
    const code = page.searchParams.get('code')
    if (code === null) throw new Error('the server reported no code')
    const exchanged = yield* Effect.promise(() => httpGet(page.href))
    const cookie = exchanged.setCookie?.split(';')[0]
    if (cookie === undefined) throw new Error('the server set no cookie')
    const token = cookie.slice(cookie.indexOf('=') + 1)
    return {
      origin: page.origin,
      localUrl: urls.local,
      tailnetUrls: urls.tailnet,
      publicUrl: urls.public,
      code,
      token,
      cookie,
      exchangeStatus: exchanged.status,
      exchangeLocation: exchanged.location,
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
              command: { kind: 'submit', text: 'hello', mode: 'steer' },
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
    expect(observed.commands).toEqual([{ kind: 'submit', text: 'hello', mode: 'steer' }])
    expect(observed.received?.kind).toBe('session')
    expect(observed.homeStatus).toBe(200)
    expect(observed.home).toContain('<h1>jozo-harness</h1>')
    expect(observed.missingStatus).toBe(404)
    expect(observed.traversalStatus).toBe(404)
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  test('a submitted line carries the body of the @file it names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-root-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-workspace-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    await writeFileDeep(join(workspace, 'src/notes.md'), 'the file body')
    const web = makeWeb('a', workspace)

    const commands = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, makeSettings())
          const ask = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            yield* client.command({
              sessionId: 'a',
              command: { kind: 'submit', text: 'read @src/notes.md' },
            })
          }).pipe(clientLayers(started.wsUrl))
          yield* withoutServices(ask)
          yield* Deferred.succeed(started.stop, undefined)
          return web.hosts.get('a')?.commands ?? []
        }),
      ),
    )

    const submitted = commands.find((command) => command.kind === 'submit')
    expect(submitted?.kind === 'submit' ? submitted.references : undefined).toEqual([
      { kind: 'file', path: 'src/notes.md', text: 'the file body' },
    ])
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  test('a page creates, stops, and removes a schedule in the host store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-schedule-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, makeSettings())
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const created = yield* client.scheduleCreate({
              sessionId: 'a',
              prompt: 'check the build',
              title: 'build',
              after: 60,
            })
            const id = created[0]?.id ?? ''
            const paused = yield* client.schedulePause({ sessionId: 'a', id, paused: true })
            const refused = yield* client
              .scheduleCreate({ sessionId: 'a', prompt: 'never', cron: '0 0 30 2 *' })
              .pipe(Effect.flip)
            // A page may name an id another tab just removed; the route says why.
            const missingPause = yield* client
              .schedulePause({ sessionId: 'a', id: 'gone', paused: true })
              .pipe(Effect.flip)
            const missingDelete = yield* client
              .scheduleDelete({ sessionId: 'a', id: 'gone' })
              .pipe(Effect.flip)
            const deleted = yield* client.scheduleDelete({ sessionId: 'a', id })
            return { created, paused, refused, missingPause, missingDelete, deleted }
          }).pipe(clientLayers(started.wsUrl))
          const answer = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return answer
        }),
      ),
    )

    expect(observed.created).toMatchObject([{ when: 'in 60s', title: 'build', paused: false }])
    expect(observed.paused).toMatchObject([{ paused: true }])
    expect(observed.refused).toContain('never comes around')
    expect(observed.missingPause).toContain('no schedule with that id in this session')
    expect(observed.missingDelete).toContain('no schedule with that id in this session')
    expect(observed.deleted).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test('the session list reports why it cannot be read when the settings are gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-settings-gone-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const base = makeSettings()
    const settings = {
      ...base,
      port: {
        ...base.port,
        read: () => Effect.fail(new WebError({ message: 'cannot read the settings file' })),
      } satisfies SettingsPort,
    }

    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const refused = yield* client.sessions().pipe(Effect.flip)
            return String(refused)
          }).pipe(clientLayers(started.wsUrl))
          const answered = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return answered
        }),
      ),
    )

    expect(failure).toContain('cannot read the settings file')
    await rm(root, { recursive: true, force: true })
  })

  test('the workspace list reports why it cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-workspaces-gone-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const base = makeWorkspaces()
    const workspaces = {
      ...base,
      port: {
        ...base.port,
        list: () => Effect.fail(new WebError({ message: 'the workspace list is gone' })),
      } satisfies WorkspacesPort,
    }

    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, makeSettings(), workspaces)
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const refused = yield* client.workspaces().pipe(Effect.flip)
            return String(refused)
          }).pipe(clientLayers(started.wsUrl))
          const answered = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return answered
        }),
      ),
    )

    expect(failure).toContain('the workspace list is gone')
    await rm(root, { recursive: true, force: true })
  })

  test('a page reads inline or as a download, and asks without a cookie are refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-home-'))
    const sessionRoot = join(home, 'sessions')
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    await writeFileDeep(join(home, 'artifacts', 'a', 'report.html'), '<h1>report</h1>')
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
          const page = started.origin + '/artifact/a/report'
          const served = yield* Effect.promise(() =>
            fetch(page, { headers: { cookie: started.cookie } }),
          )
          const text = yield* Effect.promise(() => served.text())
          const download = yield* Effect.promise(() =>
            fetch(page + '?download=1', { headers: { cookie: started.cookie } }),
          )
          const downloadText = yield* Effect.promise(() => download.text())
          const anonymous = yield* Effect.promise(() => fetch(page))
          const anonymousDownload = yield* Effect.promise(() => fetch(page + '?download=1'))
          const traversal = yield* Effect.promise(() =>
            fetch(started.origin + '/artifact/a/..%2fsecret', {
              headers: { cookie: started.cookie },
            }),
          )
          const unknown = yield* Effect.promise(() =>
            fetch(started.origin + '/artifact/a/missing', { headers: { cookie: started.cookie } }),
          )
          const foreignHost = yield* Effect.promise(() => httpGet(page, 'evil.example'))
          yield* Deferred.succeed(started.stop, undefined)
          return {
            status: served.status,
            type: served.headers.get('content-type'),
            policy: served.headers.get('content-security-policy'),
            nosniff: served.headers.get('x-content-type-options'),
            disposition: served.headers.get('content-disposition'),
            text,
            downloadStatus: download.status,
            downloadDisposition: download.headers.get('content-disposition'),
            downloadText,
            anonymous: anonymous.status,
            anonymousDownload: anonymousDownload.status,
            traversal: traversal.status,
            unknown: unknown.status,
            foreignHost: foreignHost.status,
          }
        }),
      ),
    )

    expect(observed.status).toBe(200)
    expect(observed.type).toBe('text/html; charset=utf-8')
    expect(observed.policy).toBe('sandbox allow-scripts')
    expect(observed.nosniff).toBe('nosniff')
    expect(observed.disposition).toBeNull()
    expect(observed.text).toContain('<h1>report</h1>')
    expect(observed.downloadStatus).toBe(200)
    expect(observed.downloadDisposition).toBe('attachment; filename="report.html"')
    expect(observed.downloadText).toContain('<h1>report</h1>')
    expect(observed.anonymous).toBe(401)
    expect(observed.anonymousDownload).toBe(401)
    expect(observed.traversal).toBe(400)
    expect(observed.unknown).toBe(404)
    expect(observed.foreignHost).toBe(403)
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('a page exports a session log and transcript without starting a turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-export-'))
    const sessionRoot = join(root, 'sessions')
    const id = 'exported'
    const events: ReadonlyArray<SessionEvent> = [
      {
        seq: 1,
        time: 1,
        type: 'session/header',
        data: { formatVersion: 1, createdAt: 0, cwd: '/work' },
      },
      { seq: 2, time: 2, type: 'user/message', data: { text: 'count the files', source: 'user' } },
      {
        seq: 3,
        time: 3,
        type: 'assistant/message',
        data: {
          provider: 'stub',
          model: 'stub/model',
          stream: [],
          content: [{ type: 'text', text: 'twelve files' }],
        },
      },
      {
        seq: 4,
        time: 4,
        type: 'tool/result',
        data: { callId: 'c1', isError: false, content: [{ type: 'text', text: 'a.txt' }] },
      },
    ]
    await writeFileDeep(
      join(sessionRoot, id, 'session.v1.jsonl'),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    )
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
          const started = yield* start(
            root,
            web,
            settings,
            makeWorkspaces(),
            undefined,
            undefined,
            undefined,
            (named) => Effect.succeed(named === id ? events : []),
          )
          const cookie = { headers: { cookie: started.cookie } }
          const zip = yield* Effect.promise(() =>
            fetch(started.origin + '/session/' + id + '/log.zip', cookie),
          )
          const zipBytes = yield* Effect.promise(() => zip.arrayBuffer())
          const transcript = yield* Effect.promise(() =>
            fetch(started.origin + '/session/' + id + '/transcript.md', cookie),
          )
          const markdown = yield* Effect.promise(() => transcript.text())
          const anonymous = yield* Effect.promise(() =>
            fetch(started.origin + '/session/' + id + '/transcript.md'),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return {
            zipStatus: zip.status,
            zipType: zip.headers.get('content-type'),
            zipName: zip.headers.get('content-disposition'),
            zipSignature: Buffer.from(zipBytes).subarray(0, 2).toString('utf8'),
            transcriptStatus: transcript.status,
            transcriptType: transcript.headers.get('content-type'),
            markdown,
            anonymous: anonymous.status,
            opened: web.hosts.size,
            exportOpened: web.hosts.has(id),
            commands: web.hosts.get('a')?.commands ?? [],
          }
        }),
      ),
    )

    expect(observed.zipStatus).toBe(200)
    expect(observed.zipType).toBe('application/zip')
    expect(observed.zipName).toBe('attachment; filename="' + id + '.zip"')
    expect(observed.zipSignature).toBe('PK')
    expect(observed.transcriptStatus).toBe(200)
    expect(observed.transcriptType).toBe('text/markdown; charset=utf-8')
    expect(observed.markdown).toContain('## User\n\ncount the files')
    expect(observed.markdown).toContain('## Assistant\n\ntwelve files')
    expect(observed.markdown).toContain('## Tool result')
    expect(observed.markdown).toContain('a.txt')
    expect(observed.anonymous).toBe(401)
    // Exporting reads the log; it neither opens a core nor sends it a command.
    expect(observed.opened).toBe(1)
    expect(observed.exportOpened).toBe(false)
    expect(observed.commands).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test('a page the tool wrote under a changed session root is served on the route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-tool-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-tool-home-'))
    // A root outside the default proves the tool and the route both follow it.
    const sessionRoot = join(home, 'logs')
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    await Effect.runPromise(
      makeArtifactTool(sessionRoot).execute(
        { name: 'report', html: '<h1>report</h1>' },
        { sessionId: 'a', cwd: home, callId: 'c1' },
      ),
    )
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
          const served = yield* Effect.promise(() =>
            fetch(started.origin + '/artifact/a/report', {
              headers: { cookie: started.cookie },
            }),
          )
          const text = yield* Effect.promise(() => served.text())
          yield* Deferred.succeed(started.stop, undefined)
          return { status: served.status, text }
        }),
      ),
    )

    expect(observed.status).toBe(200)
    expect(observed.text).toContain('<h1>report</h1>')
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('the artifact list names a session html in order, and an absent session is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-list-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-list-home-'))
    const sessionRoot = join(home, 'sessions')
    const artifacts = join(home, 'artifacts', 'a')
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    await writeFileDeep(join(artifacts, 'beta.html'), '<h1>beta</h1>')
    await writeFileDeep(join(artifacts, 'alpha.html'), '<h1>alpha</h1>')
    // A directory that ends in .html is not a page, and a link to a page that
    // is gone cannot be listed either.
    await mkdir(join(artifacts, 'gamma.html'))
    await symlink(join(artifacts, 'missing.html'), join(artifacts, 'broken.html'))
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
          const listUrl = started.origin + '/artifacts/a'
          const listed = yield* Effect.promise(() =>
            fetch(listUrl, { headers: { cookie: started.cookie } }),
          )
          const text = yield* Effect.promise(() => listed.text())
          const empty = yield* Effect.promise(() =>
            fetch(started.origin + '/artifacts/none', { headers: { cookie: started.cookie } }),
          )
          const emptyText = yield* Effect.promise(() => empty.text())
          const anonymous = yield* Effect.promise(() => fetch(listUrl))
          yield* Deferred.succeed(started.stop, undefined)
          return {
            status: listed.status,
            type: listed.headers.get('content-type'),
            listed: artifactEntries(text),
            empty: artifactEntries(emptyText),
            anonymous: anonymous.status,
          }
        }),
      ),
    )

    expect(observed.status).toBe(200)
    expect(observed.type).toBe('application/json; charset=utf-8')
    expect(observed.listed.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
    expect(observed.listed.map((entry) => entry.path)).toEqual([
      '/artifact/a/alpha',
      '/artifact/a/beta',
    ])
    for (const entry of observed.listed) {
      const info = await stat(join(artifacts, entry.name + '.html'))
      expect(entry.bytes).toBe(info.size)
      expect(Number.isNaN(Date.parse(entry.updatedAt))).toBe(false)
    }
    expect(observed.empty).toEqual([])
    expect(observed.anonymous).toBe(401)
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('a page attaches bytes under the session root and is told when the name is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-attach-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-attach-home-'))
    const sessionRoot = join(home, 'sessions')
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
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
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const kept = yield* client.attach({
              name: 'notes.txt',
              mediaType: 'text/plain',
              data: Buffer.from('the notes').toString('base64'),
            })
            const refused = yield* client
              .attach({ name: '', mediaType: 'text/plain', data: '' })
              .pipe(Effect.flip)
            return { kept, refused: String(refused) }
          }).pipe(clientLayers(started.wsUrl))
          const answered = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return answered
        }),
      ),
    )

    expect(observed.kept.name).toBe('notes.txt')
    expect(observed.kept.bytes).toBe('the notes'.length)
    expect(observed.refused).toContain('the attachment has no file name')
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('the plugin route lists the rows the run was built from, and refuses an anonymous page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-plugins-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const listed = yield* Effect.promise(() =>
            fetch(started.origin + '/plugins', { headers: { cookie: started.cookie } }),
          )
          const text = yield* Effect.promise(() => listed.text())
          const anonymous = yield* Effect.promise(() => fetch(started.origin + '/plugins'))
          yield* Deferred.succeed(started.stop, undefined)
          return {
            status: listed.status,
            type: listed.headers.get('content-type'),
            text,
            anonymous: anonymous.status,
          }
        }),
      ),
    )

    expect(observed.status).toBe(200)
    expect(observed.type).toBe('application/json; charset=utf-8')
    expect(JSON.parse(observed.text)).toEqual({ rows: [], catalog: [], failures: [] })
    expect(observed.anonymous).toBe(401)
    await rm(root, { recursive: true, force: true })
  })

  test('the plugin route refuses a change without the cookie or the token, and one from another origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-plugins-gate-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const change = JSON.stringify({ action: 'set-enabled', id: 'lsp', enabled: false })
          const answer = (headers: Record<string, string>, url = started.origin + '/plugins') =>
            Effect.promise(() =>
              fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body: change,
              }),
            )
          const withCookie = yield* answer({ cookie: started.cookie })
          const withToken = yield* answer({}, started.origin + '/plugins?token=' + started.token)
          const anonymous = yield* answer({})
          const foreign = yield* answer({ cookie: started.cookie, origin: 'http://evil.example' })
          yield* Deferred.succeed(started.stop, undefined)
          return {
            cookie: withCookie.status,
            token: withToken.status,
            anonymous: anonymous.status,
            foreign: foreign.status,
          }
        }),
      ),
    )

    expect(observed).toEqual({ cookie: 200, token: 200, anonymous: 401, foreign: 403 })
    await rm(root, { recursive: true, force: true })
  })

  test('a plugin change answers the view the port leaves, and installs only a catalog bundle this build has', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-plugins-change-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()
    const changes: Array<PluginChangeRequest> = []
    let current: PluginsView = {
      rows: [{ id: 'lsp', name: '@jozo-harness/lsp', enabled: true, running: true }],
      catalog: [
        {
          id: 'artifact',
          name: '@jozo-harness/artifact',
          summary: 'publish pages',
          needsConfig: false,
          installed: false,
        },
      ],
      failures: [],
    }
    const port: PluginsPort = {
      view: () => current,
      known: () => ['@jozo-harness/lsp', '@jozo-harness/artifact'],
      change: async (change) => {
        changes.push(change)
        current = {
          ...current,
          rows: [
            { id: 'lsp', name: '@jozo-harness/lsp', enabled: false, running: true },
            { id: 'artifact', name: '@jozo-harness/artifact', enabled: true, running: false },
          ],
          catalog: current.catalog.map((entry) => ({ ...entry, installed: true })),
        }
        return { ok: true }
      },
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            settings,
            makeWorkspaces(),
            undefined,
            undefined,
            port,
          )
          const post = (body: unknown): Promise<Response> =>
            fetch(started.origin + '/plugins', {
              method: 'POST',
              headers: { cookie: started.cookie, 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
          const toggled = yield* Effect.promise(() =>
            post({ action: 'set-enabled', id: 'lsp', enabled: false }),
          )
          const toggledText = yield* Effect.promise(() => toggled.text())
          const unknown = yield* Effect.promise(() =>
            post({ action: 'install', id: 'nope', name: '@jozo-harness/nope' }),
          )
          const unknownText = yield* Effect.promise(() => unknown.text())
          const installed = yield* Effect.promise(() =>
            post({ action: 'install', id: 'artifact', name: '@jozo-harness/artifact' }),
          )
          const installedText = yield* Effect.promise(() => installed.text())
          yield* Deferred.succeed(started.stop, undefined)
          return {
            toggled: toggled.status,
            toggledText,
            unknown: unknown.status,
            unknownText,
            installed: installed.status,
            installedView: JSON.parse(installedText) as PluginsView,
          }
        }),
      ),
    )

    expect(observed.toggled).toBe(200)
    expect(JSON.parse(observed.toggledText)).toEqual({
      rows: [
        { id: 'lsp', name: '@jozo-harness/lsp', enabled: false, running: true },
        { id: 'artifact', name: '@jozo-harness/artifact', enabled: true, running: false },
      ],
      catalog: [
        {
          id: 'artifact',
          name: '@jozo-harness/artifact',
          summary: 'publish pages',
          needsConfig: false,
          installed: true,
        },
      ],
      failures: [],
    })
    expect(observed.unknown).toBe(400)
    expect(observed.unknownText).toContain('this build does not have @jozo-harness/nope')
    expect(observed.installed).toBe(200)
    expect(observed.installedView.catalog[0]?.installed).toBe(true)
    // The refused name never reached the port; the two accepted changes did.
    expect(changes).toEqual([
      { action: 'set-enabled', id: 'lsp', enabled: false },
      { action: 'install', id: 'artifact', name: '@jozo-harness/artifact' },
    ])
    await rm(root, { recursive: true, force: true })
  })

  test('a plugin install the route cannot take is refused before the port changes anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-plugins-body-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()
    const changes: Array<PluginChangeRequest> = []
    const port: PluginsPort = {
      view: () => ({
        rows: [],
        catalog: [
          {
            id: 'mcp',
            name: '@jozo-harness/mcp',
            summary: 'connect MCP servers',
            needsConfig: true,
            installed: false,
          },
        ],
        failures: [],
      }),
      known: () => ['@jozo-harness/mcp'],
      change: async (change) => {
        changes.push(change)
        return { ok: true }
      },
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            settings,
            makeWorkspaces(),
            undefined,
            undefined,
            port,
          )
          const post = (body: string): Promise<Response> =>
            fetch(started.origin + '/plugins', {
              method: 'POST',
              headers: { cookie: started.cookie, 'content-type': 'application/json' },
              body,
            })
          const notJson = yield* Effect.promise(() => post('{'))
          const notAChange = yield* Effect.promise(() =>
            post(JSON.stringify({ action: 'set-enabled', id: 'lsp' })),
          )
          const needsConfig = yield* Effect.promise(() =>
            post(JSON.stringify({ action: 'install', id: 'mcp', name: '@jozo-harness/mcp' })),
          )
          const wrongId = yield* Effect.promise(() =>
            post(JSON.stringify({ action: 'install', id: 'other', name: '@jozo-harness/mcp' })),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return {
            notJson: notJson.status,
            notAChange: notAChange.status,
            needsConfig: needsConfig.status,
            needsConfigText: yield* Effect.promise(() => needsConfig.text()),
            wrongId: wrongId.status,
          }
        }),
      ),
    )

    expect(observed).toEqual({
      notJson: 400,
      notAChange: 400,
      needsConfig: 400,
      needsConfigText:
        '@jozo-harness/mcp needs config in the settings file, so the page cannot install it',
      wrongId: 400,
    })
    expect(changes).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test('a plugin change the port could not apply answers 500 without a view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-plugins-broken-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()
    const port: PluginsPort = {
      view: () => ({ rows: [], catalog: [], failures: [] }),
      known: () => [],
      change: async () => {
        throw new Error('the store went away')
      },
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            settings,
            makeWorkspaces(),
            undefined,
            undefined,
            port,
          )
          const answer = yield* Effect.promise(() =>
            fetch(started.origin + '/plugins', {
              method: 'POST',
              headers: { cookie: started.cookie, 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'retry', id: 'lsp' }),
            }),
          )
          const text = yield* Effect.promise(() => answer.text())
          yield* Deferred.succeed(started.stop, undefined)
          return { status: answer.status, text }
        }),
      ),
    )

    expect(observed).toEqual({ status: 500, text: 'the plugin change failed' })
    await rm(root, { recursive: true, force: true })
  })

  test('a refused plugin change answers with the reason the port gave', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-plugins-refused-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()
    const port: PluginsPort = {
      view: () => ({ rows: [], catalog: [], failures: [] }),
      known: () => [],
      change: async (): Promise<PluginChangeAnswer> => ({
        ok: false,
        status: 409,
        message: 'the settings refused the change',
      }),
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            settings,
            makeWorkspaces(),
            undefined,
            undefined,
            port,
          )
          const answer = yield* Effect.promise(() =>
            fetch(started.origin + '/plugins', {
              method: 'POST',
              headers: { cookie: started.cookie, 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'retry', id: 'lsp' }),
            }),
          )
          const text = yield* Effect.promise(() => answer.text())
          yield* Deferred.succeed(started.stop, undefined)
          return { status: answer.status, text }
        }),
      ),
    )

    expect(observed).toEqual({ status: 409, text: 'the settings refused the change' })
    await rm(root, { recursive: true, force: true })
  })

  test('a deleted page is gone from its session while another session keeps its own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-delete-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-delete-home-'))
    const sessionRoot = join(home, 'sessions')
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    await writeFileDeep(join(home, 'artifacts', 'a', 'report.html'), '<h1>report</h1>')
    await writeFileDeep(join(home, 'artifacts', 'b', 'other.html'), '<h1>other</h1>')
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
          const page = started.origin + '/artifact/a/report'
          const remove = (): Promise<Response> =>
            fetch(page, {
              method: 'DELETE',
              headers: { cookie: started.cookie, origin: started.origin },
            })
          const removed = yield* Effect.promise(remove)
          const gone = yield* Effect.promise(() =>
            fetch(page, { headers: { cookie: started.cookie } }),
          )
          const other = yield* Effect.promise(() =>
            fetch(started.origin + '/artifact/b/other', { headers: { cookie: started.cookie } }),
          )
          const listed = yield* Effect.promise(() =>
            fetch(started.origin + '/artifacts/a', { headers: { cookie: started.cookie } }),
          )
          const listedText = yield* Effect.promise(() => listed.text())
          const again = yield* Effect.promise(remove)
          yield* Deferred.succeed(started.stop, undefined)
          return {
            removed: removed.status,
            gone: gone.status,
            other: other.status,
            listed: artifactEntries(listedText),
            again: again.status,
          }
        }),
      ),
    )

    expect(observed.removed).toBe(204)
    expect(observed.gone).toBe(404)
    expect(observed.other).toBe(200)
    expect(observed.listed).toEqual([])
    expect(observed.again).toBe(404)
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('a delete without the gate, a safe name, or an existing page is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-delete-refuse-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-artifact-delete-refuse-home-'))
    const sessionRoot = join(home, 'sessions')
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    await writeFileDeep(join(home, 'artifacts', 'a', 'report.html'), '<h1>report</h1>')
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
          const page = started.origin + '/artifact/a/report'
          const anonymous = yield* Effect.promise(() =>
            fetch(page, { method: 'DELETE', headers: { 'x-requested-with': 'XMLHttpRequest' } }),
          )
          const unproven = yield* Effect.promise(() =>
            fetch(page, { method: 'DELETE', headers: { cookie: started.cookie } }),
          )
          const foreign = yield* Effect.promise(() =>
            fetch(page, {
              method: 'DELETE',
              headers: { cookie: started.cookie, origin: 'http://evil.example' },
            }),
          )
          const traversal = yield* Effect.promise(() =>
            fetch(started.origin + '/artifact/a/..%2fsecret', {
              method: 'DELETE',
              headers: { cookie: started.cookie, origin: started.origin },
            }),
          )
          const missing = yield* Effect.promise(() =>
            fetch(started.origin + '/artifact/a/missing', {
              method: 'DELETE',
              headers: { cookie: started.cookie, origin: started.origin },
            }),
          )
          const listed = yield* Effect.promise(() =>
            fetch(started.origin + '/artifacts/a', { headers: { cookie: started.cookie } }),
          )
          const listedText = yield* Effect.promise(() => listed.text())
          yield* Deferred.succeed(started.stop, undefined)
          return {
            anonymous: anonymous.status,
            unproven: unproven.status,
            foreign: foreign.status,
            traversal: traversal.status,
            missing: missing.status,
            listed: artifactEntries(listedText),
          }
        }),
      ),
    )

    expect(observed.anonymous).toBe(401)
    expect(observed.unproven).toBe(403)
    expect(observed.foreign).toBe(403)
    expect(observed.traversal).toBe(400)
    expect(observed.missing).toBe(404)
    expect(observed.listed.map((entry) => entry.name)).toEqual(['report'])
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
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

  test('opening a session on one page announces it to the other page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-announce-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = started.wsUrl
          const usePages = Effect.gen(function* () {
            const one = yield* RpcClient.make(UiRpcs)
            const two = yield* RpcClient.make(UiRpcs)
            // The second page listens before the first one acts: a page that only
            // reads the store again when a session event happens to refresh it
            // would keep the list it saw at load.
            const announced = yield* Effect.forkScoped(
              two.storeChanged().pipe(Stream.take(1), Stream.runCollect),
            )
            yield* Effect.sleep(50)
            const opened = yield* one.open({ cwd: '/work' })
            const heard = yield* Fiber.join(announced).pipe(Effect.timeoutOption('1 second'))
            const listed = yield* two.sessions()
            return { opened: opened.id, heard: Option.isSome(heard), listed }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(usePages)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.opened).toBe('new-2')
    expect(observed.heard).toBe(true)
    expect(observed.listed.opened).toEqual(['a', 'new-2'])
    await rm(root, { recursive: true, force: true })
  })

  test('a command one page sends reaches the page that follows the same session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-command-tabs-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = started.wsUrl
          const usePages = Effect.gen(function* () {
            const one = yield* RpcClient.make(UiRpcs)
            const two = yield* RpcClient.make(UiRpcs)
            const heard = yield* Effect.forkScoped(
              two.events({ sessionId: 'a' }).pipe(Stream.take(1), Stream.runCollect),
            )
            yield* Effect.sleep(50)
            const accepted = yield* one.command({
              sessionId: 'a',
              command: { kind: 'submit', text: 'from the other device' },
            })
            const received = yield* Fiber.join(heard).pipe(Effect.timeoutOption('1 second'))
            const type = Option.match(received, {
              onNone: () => '',
              onSome: (events) => {
                const first = [...events][0]
                return first?.kind === 'session' ? first.event.type : ''
              },
            })
            return { accepted, type }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(usePages)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.accepted).toBe(true)
    expect(observed.type).toBe('user/message')
    await rm(root, { recursive: true, force: true })
  })

  test('an approval one page answers reaches the page that follows the same session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-approval-tabs-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const wsUrl = started.wsUrl
          const usePages = Effect.gen(function* () {
            const one = yield* RpcClient.make(UiRpcs)
            const two = yield* RpcClient.make(UiRpcs)
            const heard = yield* Effect.forkScoped(
              two.events({ sessionId: 'a' }).pipe(Stream.take(1), Stream.runCollect),
            )
            yield* Effect.sleep(50)
            const accepted = yield* one.command({
              sessionId: 'a',
              command: { kind: 'approve', callId: 'c1', approved: true },
            })
            const received = yield* Fiber.join(heard).pipe(Effect.timeoutOption('1 second'))
            const answered = Option.match(received, {
              onNone: () => '',
              onSome: (events) => {
                const first = [...events][0]
                if (first?.kind !== 'session') return ''
                const data = first.event.data as { approved?: boolean }
                return first.event.type + ':' + String(data.approved)
              },
            })
            return { accepted, answered }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(usePages)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.accepted).toBe(true)
    expect(observed.answered).toBe('safety/approval/answered:true')
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

  test('the viewer opens the session workspace without starting a turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-open-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const requests: Array<{ readonly app: string; readonly root: string; readonly path: string }> =
      []
    const openInApp: OpenInAppPort = {
      apps: () => ({ apps: [{ id: 'finder', label: 'Finder' }] }),
      open: (request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            makeSettings(),
            makeWorkspaces(),
            undefined,
            undefined,
            {
              view: () => ({ rows: [], catalog: [], failures: [] }),
              known: () => [],
              change: async () => ({ ok: true }),
            },
            () => Effect.succeed([]),
            [],
            openInApp,
          )
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const apps = yield* client.openApps()
            const opened = yield* client.openInApp({ sessionId: 'a', app: 'finder', path: '' })
            return {
              apps,
              opened,
              requests,
              commands: web.hosts.get('a')?.commands ?? [],
            }
          }).pipe(clientLayers(started.wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.apps).toEqual({ apps: [{ id: 'finder', label: 'Finder' }] })
    expect(observed.opened).toBe(true)
    expect(observed.requests).toEqual([{ app: 'finder', root: '/work', path: '' }])
    // Opening a folder on the reader's machine is not something the model said.
    expect(observed.commands).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test('a run without an app tells the page why it has nothing to open the workspace with', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-open-none-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, makeWeb('a'), makeSettings())
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            return yield* client.openApps()
          }).pipe(clientLayers(started.wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed).toEqual({
      apps: [],
      reason: 'this run has no app to open a workspace with',
    })
    await rm(root, { recursive: true, force: true })
  })

  test('the open route refuses a session that is not open and repeats why the app failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-open-refused-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const openInApp: OpenInAppPort = {
      apps: () => ({ apps: [{ id: 'finder', label: 'Finder' }] }),
      open: () => Effect.fail('the app could not open the folder'),
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            makeWeb('a'),
            makeSettings(),
            makeWorkspaces(),
            undefined,
            undefined,
            undefined,
            () => Effect.succeed([]),
            [],
            openInApp,
          )
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const closed = yield* client
              .openInApp({ sessionId: 'gone', app: 'finder', path: '' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const refused = yield* client
              .openInApp({ sessionId: 'a', app: 'finder', path: '' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { closed, refused }
          }).pipe(clientLayers(started.wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.closed).toBe('the session is not open')
    expect(observed.refused).toBe('the app could not open the folder')
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

  test('a fork copies the parent log into a new session and records where it began', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-fork-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-fork-home-'))
    const sessionRoot = join(home, 'sessions')
    await mkdir(join(sessionRoot, 'a'), { recursive: true })
    await mkdir(join(sessionRoot, 'b'), { recursive: true })
    // The fake store names the next session new-2, and the route checks its log exists.
    await mkdir(join(sessionRoot, 'new-2'), { recursive: true })
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
            const forked = yield* client.forkSession({ sessionId: 'a' })
            const listed = yield* client.sessions()
            return { forked, listed, seeds: web.seeds }
          }).pipe(clientLayers(wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.forked.id).toBe('new-2')
    expect(observed.forked.forkOf).toBe('a')
    // The last user message is the task the parent ran; the fork starts before it.
    expect(observed.seeds.at(-1)?.map((event) => event.seq)).toEqual([1])
    expect(observed.listed.items.find((item) => item.id === 'a')?.forkOf).toBeUndefined()
    expect(observed.listed.items.map((item) => item.id)).toContain('new-2')
    expect(observed.listed.opened).toContain('new-2')
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('the row menu deletes an open session, and its pages with it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-menu-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-menu-home-'))
    const sessionRoot = join(home, 'sessions')
    await mkdir(join(sessionRoot, 'a'), { recursive: true })
    await mkdir(join(sessionRoot, 'b'), { recursive: true })
    await writeFileDeep(join(home, 'artifacts', 'a', 'report.html'), '<h1>report</h1>')
    await writeFileDeep(join(home, 'artifacts', 'b', 'other.html'), '<h1>other</h1>')
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
              const missing = async (path: string): Promise<boolean> => {
                try {
                  await stat(path)
                  return false
                } catch {
                  return true
                }
              }
              return {
                log: await missing(join(sessionRoot, 'a')),
                artifacts: await missing(join(home, 'artifacts', 'a')),
              }
            })
            const pages = yield* Effect.promise(async () => {
              const [own, other] = await Promise.all([
                fetch(started.origin + '/artifact/a/report', {
                  headers: { cookie: started.cookie },
                }),
                fetch(started.origin + '/artifact/b/other', {
                  headers: { cookie: started.cookie },
                }),
              ])
              return { own: own.status, other: other.status }
            })
            return { pinned, listed, opened, deleted, after, gone, pages }
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
    // The log and its pages are gone from disk, and the rail no longer lists it.
    expect(observed.gone).toEqual({ log: true, artifacts: true })
    expect(observed.after.opened).toEqual([])
    expect(observed.after.initial).toBe('')
    // Deleting a session takes its pages with it; another session keeps its own.
    expect(observed.pages).toEqual({ own: 404, other: 200 })
    // The core was released before the directory went away.
    expect(web.closed).toEqual(['a'])
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
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

  test('the page reads and saves the editable settings through the run port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-run-settings-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const base = makeSettings()
    const saved: Array<RunSettingsInput> = []
    const editable: EditableSettingsView = {
      search: {
        provider: 'deepseek',
        keyName: 'DEEPSEEK_API_KEY',
        keyPresent: true,
        source: '/work/settings.yml',
      },
      apiKeyRef: { ref: 'openrouter', present: true, source: '/work/settings.yml' },
      bashTimeoutMs: { value: 45_000, source: '/work/settings.yml' },
      maxParallelToolCalls: { value: 4, source: 'the default' },
      subagentDepth: { value: 2, source: '/work/settings.yml' },
      delegateTools: [{ name: 'codex', argv: ['codex', 'exec'] }],
    }
    const settings = {
      ...base,
      port: {
        ...base.port,
        editable: () => Effect.succeed(editable),
        saveEditable: (input: RunSettingsInput) =>
          input.bashTimeoutMs === 0
            ? Effect.fail(new WebError({ message: 'bashTimeoutMs: a whole number is required' }))
            : Effect.sync(() => {
                saved.push(input)
              }).pipe(Effect.as(editable)),
      } satisfies SettingsPort,
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const read = yield* client.runSettings()
            const input: RunSettingsInput = {
              search: 'exa',
              apiKeyRef: 'openrouter',
              bashTimeoutMs: 45_000,
              maxParallelToolCalls: 4,
              subagentDepth: 2,
              delegateTools: [{ name: 'codex', argv: ['codex', 'exec'] }],
            }
            const written = yield* client.saveRunSettings(input)
            const refused = yield* client
              .saveRunSettings({ ...input, bashTimeoutMs: 0 })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return { read, written, refused }
          }).pipe(clientLayers(started.wsUrl))
          const result = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.read).toEqual(editable)
    expect(observed.written).toEqual(editable)
    // The field the writer refused comes back as the server named it.
    expect(observed.refused).toBe('bashTimeoutMs: a whole number is required')
    expect(saved).toHaveLength(1)
    expect(saved[0]?.search).toBe('exa')
    await rm(root, { recursive: true, force: true })
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
            const sent = yield* client.messageSubagent({
              sessionId: 'a',
              id: 'child-1',
              message: 'try the second test',
            })
            const unknownChild = yield* client
              .stopSubagent({ sessionId: 'a', id: 'child-9' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const unknownFollowUp = yield* client
              .messageSubagent({ sessionId: 'a', id: 'child-9', message: 'hello' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const unknownJob = yield* client
              .jobDetail({ sessionId: 'a', id: 'j-9' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            return {
              running,
              refused,
              detail,
              stopped,
              childStopped,
              sent,
              unknownChild,
              unknownFollowUp,
              unknownJob,
            }
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
      {
        id: 'child-1',
        status: 'running',
        startedAt: 1_700_000_000_000,
        depth: 1,
        maxDepth: 2,
      },
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
    expect(observed.sent).toEqual({ id: 'child-1', queued: false })
    expect(observed.unknownChild).toBe('the subagent is not running')
    expect(observed.unknownFollowUp).toBe('the subagent is not running')
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
      editable: () => Effect.fail(new WebError({ message: 'no settings here' })),
      saveEditable: () => Effect.fail(new WebError({ message: 'no writing here' })),
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

  test('the ready url carries a one-time code the page trades for a cookie', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-root-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const settings = makeSettings()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, settings)
          const socket = 'ws://' + new URL(started.origin).host + '/ui'
          const reused = yield* Effect.promise(() =>
            httpGet(started.origin + '/?code=' + started.code),
          )
          const expiredCode = yield* Effect.promise(() =>
            httpGet(started.origin + '/?code=' + 'x'.repeat(64)),
          )
          const noToken = yield* Effect.promise(() => attemptSocket(socket))
          const wrongToken = yield* Effect.promise(() =>
            attemptSocket(socket + '?token=' + 'x'.repeat(started.token.length)),
          )
          const rightToken = yield* Effect.promise(() => attemptSocket(started.wsUrl))
          const cookieOnly = yield* Effect.promise(() =>
            attemptSocket(socket, { headers: { cookie: started.cookie } }),
          )
          const foreignOrigin = yield* Effect.promise(() =>
            attemptSocket(started.wsUrl, { origin: 'http://evil.example' }),
          )
          const pageOrigin = yield* Effect.promise(() =>
            attemptSocket(started.wsUrl, { origin: started.origin }),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return {
            token: started.token,
            code: started.code,
            cookie: started.cookie,
            exchangeStatus: started.exchangeStatus,
            exchangeLocation: started.exchangeLocation,
            reused,
            expiredCode,
            noToken,
            wrongToken,
            rightToken,
            cookieOnly,
            foreignOrigin,
            pageOrigin,
          }
        }),
      ),
    )

    expect(observed.code).toMatch(/^[0-9a-f]{64}$/)
    expect(observed.token).toMatch(/^[0-9a-f]{64}$/)
    expect(observed.cookie).toMatch(/^jzh_web=/)
    expect(observed.exchangeStatus).toBe(303)
    expect(observed.exchangeLocation).toBe('/')
    expect(observed.reused.status).toBe(401)
    expect(observed.expiredCode.status).toBe(401)
    expect(observed.noToken).toEqual({ opened: false, status: 401 })
    expect(observed.wrongToken).toEqual({ opened: false, status: 401 })
    expect(observed.rightToken.opened).toBe(true)
    expect(observed.cookieOnly.opened).toBe(true)
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

  test('a published origin is served, and only that name joins the loopback gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-root-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const published = { host: 'myhost.tailnet.ts.net', origin: 'https://myhost.tailnet.ts.net' }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, makeSettings(), makeWorkspaces(), published)
          const port = new URL(started.origin).port
          const publicCode = new URL(started.publicUrl ?? '').searchParams.get('code') ?? ''
          const localCode = new URL(started.localUrl).searchParams.get('code') ?? ''
          // The proxy passes the browser's Host on, so the exchange names it too.
          const exchanged = yield* Effect.promise(() =>
            httpGet('http://127.0.0.1:' + port + '/?code=' + publicCode, published.host),
          )
          const cookie = exchanged.setCookie?.split(';')[0] ?? ''
          const token = cookie.slice(cookie.indexOf('=') + 1)
          const socket = 'ws://127.0.0.1:' + port + '/ui?token=' + token
          const opened = yield* Effect.promise(() =>
            attemptSocket(socket, {
              origin: published.origin,
              headers: { host: published.host },
            }),
          )
          const httpOrigin = yield* Effect.promise(() =>
            attemptSocket(socket, {
              origin: 'http://myhost.tailnet.ts.net',
              headers: { host: published.host },
            }),
          )
          const foreignHost = yield* Effect.promise(() =>
            attemptSocket(socket, { headers: { host: 'evil.example' } }),
          )
          const foreignGet = yield* Effect.promise(() =>
            httpGet('http://127.0.0.1:' + port + '/', 'evil.example'),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return {
            publicUrl: started.publicUrl,
            publicCode,
            localCode,
            exchanged,
            opened,
            httpOrigin,
            foreignHost,
            foreignGet,
          }
        }),
      ),
    )

    expect(observed.publicUrl).toMatch(/^https:\/\/myhost\.tailnet\.ts\.net\/\?code=[0-9a-f]{64}$/)
    // Each printed address carries its own one-time code: opening one spends neither.
    expect(observed.publicCode).toMatch(/^[0-9a-f]{64}$/)
    expect(observed.publicCode).not.toBe(observed.localCode)
    expect(observed.exchanged.status).toBe(303)
    // The page is https through the proxy, so the cookie says Secure even when
    // the proxy does not forward x-forwarded-proto.
    expect(observed.exchanged.setCookie).toContain('Secure')
    expect(observed.opened.opened).toBe(true)
    expect(observed.httpOrigin).toEqual({ opened: false, status: 403 })
    expect(observed.foreignHost).toEqual({ opened: false, status: 403 })
    expect(observed.foreignGet.status).toBe(403)
    await rm(root, { recursive: true, force: true })
  })

  test('a detected tailnet is served at the bound port, address and name apart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-root-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const ip = localAddress()
    const dns = 'myhost.tailnet.ts.net'

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, makeSettings(), makeWorkspaces(), undefined, {
            ip,
            dns,
          })
          const first = new URL(started.tailnetUrls[0] ?? '')
          const second = new URL(started.tailnetUrls[1] ?? '')
          const port = new URL(started.localUrl).port
          const dnsCode = second.searchParams.get('code') ?? ''
          // The page is reached at the address, but names the MagicDNS host in
          // its Host and Origin headers, as a browser would.
          const exchanged = yield* Effect.promise(() =>
            httpGet('http://' + ip + ':' + port + '/?code=' + dnsCode, dns + ':' + port),
          )
          const cookie = exchanged.setCookie?.split(';')[0] ?? ''
          const token = cookie.slice(cookie.indexOf('=') + 1)
          const socket = 'ws://' + ip + ':' + port + '/ui?token=' + token
          const opened = yield* Effect.promise(() =>
            attemptSocket(socket, {
              origin: 'http://' + dns + ':' + port,
              headers: { host: dns + ':' + port },
            }),
          )
          const ipOrigin = yield* Effect.promise(() =>
            attemptSocket(socket, {
              origin: 'http://' + ip + ':' + port,
              headers: { host: ip + ':' + port },
            }),
          )
          const portlessHost = yield* Effect.promise(() =>
            attemptSocket(socket, { headers: { host: dns } }),
          )
          const httpsOrigin = yield* Effect.promise(() =>
            attemptSocket(socket, {
              origin: 'https://' + dns + ':' + port,
              headers: { host: dns + ':' + port },
            }),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return {
            localUrl: started.localUrl,
            tailnetUrls: started.tailnetUrls,
            first,
            second,
            exchanged,
            opened,
            ipOrigin,
            portlessHost,
            httpsOrigin,
          }
        }),
      ),
    )

    const port = new URL(observed.localUrl).port
    expect(observed.tailnetUrls).toHaveLength(2)
    expect(observed.first.origin).toBe('http://' + ip + ':' + port)
    expect(observed.second.origin).toBe('http://' + dns + ':' + port)
    // Each address carries a fresh code; opening one spends neither the other
    // nor the loopback link.
    expect(observed.first.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/)
    expect(observed.second.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/)
    expect(observed.first.searchParams.get('code')).not.toBe(
      observed.second.searchParams.get('code'),
    )
    expect(observed.first.searchParams.get('code')).not.toBe(
      new URL(observed.localUrl).searchParams.get('code'),
    )
    expect(observed.exchanged.status).toBe(303)
    expect(observed.opened.opened).toBe(true)
    expect(observed.ipOrigin.opened).toBe(true)
    // The name without its port, and the https spelling, are not near misses.
    expect(observed.portlessHost).toEqual({ opened: false, status: 403 })
    expect(observed.httpsOrigin).toEqual({ opened: false, status: 403 })
    await rm(root, { recursive: true, force: true })
  })

  test('a tailnet address this machine does not hold leaves the run on loopback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-root-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const dns = 'myhost.tailnet.ts.net'

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // TEST-NET-1 is never assigned to an interface, so the second listen fails.
          const started = yield* start(root, web, makeSettings(), makeWorkspaces(), undefined, {
            ip: '192.0.2.1',
            dns,
          })
          const port = new URL(started.origin).port
          // No listener waits on the name, so the gate does not admit it either.
          const nameAtPort = yield* Effect.promise(() =>
            httpGet('http://127.0.0.1:' + port + '/', dns + ':' + port),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return { tailnetUrls: started.tailnetUrls, nameAtPort }
        }),
      ),
    )

    expect(observed.tailnetUrls).toEqual([])
    expect(observed.nameAtPort.status).toBe(403)
    await rm(root, { recursive: true, force: true })
  })
})

describe('a webhook delivery', () => {
  const rule: WebhookRule = {
    path: '/hooks/deploy',
    cwd: '/work/hooked',
    prompt: 'Read the delivery and say what changed.',
    secret: 's3cret',
  }

  const bodyOf = (padding = ''): string =>
    JSON.stringify({
      action: 'completed',
      repository: { full_name: 'acme/app' },
      sender: { login: 'octocat' },
      ...(padding === '' ? {} : { padding }),
    })

  const signatureOf = (secret: string, body: string): string =>
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

  /** The session the answer names; the route always answers JSON on a 202. */
  const sessionOf = (text: string): string => {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('sessionId' in parsed) ||
      typeof parsed.sessionId !== 'string'
    ) {
      throw new Error('the webhook answer names no session')
    }
    return parsed.sessionId
  }

  const post = (
    started: Started,
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(started.origin + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'workflow_run',
        ...headers,
      },
      body,
    })

  test('a signed POST starts one session in the rule workspace, and the page lists and opens it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-hook-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const body = bodyOf()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            makeSettings(),
            makeWorkspaces(),
            undefined,
            undefined,
            undefined,
            undefined,
            [rule],
          )
          const answer = yield* Effect.promise(() =>
            post(started, rule.path, body, {
              'x-hub-signature-256': signatureOf(rule.secret, body),
            }),
          )
          const text = yield* Effect.promise(() => answer.text())
          const sessionId = sessionOf(text)
          const useClient = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const listed = yield* client.sessions()
            const opened = yield* client.open({ sessionId })
            return { listed, opened }
          }).pipe(clientLayers(started.wsUrl))
          const page = yield* withoutServices(useClient)
          yield* Deferred.succeed(started.stop, undefined)
          return { status: answer.status, text, sessionId, page }
        }),
      ),
    )

    const made = web.hosts.get(observed.sessionId)
    expect(observed.status).toBe(202)
    expect(web.hosts.size).toBe(2)
    expect(made?.summary.cwd).toBe(rule.cwd)
    expect(made?.commands[0]?.kind).toBe('submit')
    const sent = made?.commands[0]?.kind === 'submit' ? made.commands[0].text : ''
    expect(sent).toContain('Read the delivery and say what changed.')
    expect(sent).toContain('GitHub event "workflow_run"')
    expect(sent).toContain('acme/app')
    expect(observed.page.listed.items.map((item) => item.id)).toContain(observed.sessionId)
    expect(observed.page.opened.id).toBe(observed.sessionId)
    await rm(root, { recursive: true, force: true })
  })

  test('a signature that does not match starts no session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-hook-signature-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const body = bodyOf()

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            makeSettings(),
            makeWorkspaces(),
            undefined,
            undefined,
            undefined,
            undefined,
            [rule],
          )
          const wrong = yield* Effect.promise(() =>
            post(started, rule.path, body, {
              'x-hub-signature-256': signatureOf('another secret', body),
            }),
          )
          const missing = yield* Effect.promise(() => post(started, rule.path, body))
          yield* Deferred.succeed(started.stop, undefined)
          return { wrong: wrong.status, missing: missing.status }
        }),
      ),
    )

    expect(observed).toEqual({ wrong: 401, missing: 401 })
    expect(web.hosts.size).toBe(1)
    expect(web.hosts.get('a')?.commands).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test('a path no rule names is not found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-hook-path-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const body = bodyOf()

    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            makeSettings(),
            makeWorkspaces(),
            undefined,
            undefined,
            undefined,
            undefined,
            [rule],
          )
          const answer = yield* Effect.promise(() =>
            post(started, '/hooks/other', body, {
              'x-hub-signature-256': signatureOf(rule.secret, body),
            }),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return answer.status
        }),
      ),
    )

    expect(status).toBe(404)
    expect(web.hosts.size).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  test('a body that is too large or not a JSON object is refused, and starts nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-hook-body-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')
    const oversized = bodyOf('x'.repeat(1024 * 1024))
    const notAnObject = '[]'

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(
            root,
            web,
            makeSettings(),
            makeWorkspaces(),
            undefined,
            undefined,
            undefined,
            undefined,
            [rule],
          )
          const large = yield* Effect.promise(() =>
            post(started, rule.path, oversized, {
              'x-hub-signature-256': signatureOf(rule.secret, oversized),
            }),
          )
          const shape = yield* Effect.promise(() =>
            post(started, rule.path, notAnObject, {
              'x-hub-signature-256': signatureOf(rule.secret, notAnObject),
            }),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return { large: large.status, shape: shape.status }
        }),
      ),
    )

    expect(observed).toEqual({ large: 400, shape: 400 })
    expect(web.hosts.size).toBe(1)
    await rm(root, { recursive: true, force: true })
  })
})

describe('sharing a run with another browser', () => {
  test('an invited browser reads and types in the same session through the one host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-share-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, makeSettings())
          const created = yield* Effect.promise(() =>
            httpCall(started.origin + '/share?label=Alice', 'POST', started.cookie),
          )
          const shared = sharedInvitation(created.body)
          const join = new URL(shared.url).searchParams.get('join')
          if (join === null) throw new Error('the share link carries no invitation')
          const exchanged = yield* Effect.promise(() => httpGet(shared.url))
          const joinedCookie = exchanged.setCookie?.split(';')[0]
          if (joinedCookie === undefined) throw new Error('joining set no cookie')

          const useOwner = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            return yield* client.command({
              sessionId: 'a',
              command: { kind: 'submit', text: 'hello from the owner', mode: 'steer' },
            })
          })
          const useJoined = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const listed = yield* client.sessions()
            const accepted = yield* client.command({
              sessionId: 'a',
              command: { kind: 'submit', text: 'hello from Alice', mode: 'steer' },
            })
            // The joined page follows the same log the owner's page does: the
            // owner's next line arrives here as the event the host wrote.
            const listening = yield* Effect.forkScoped(
              client.events({ sessionId: 'a' }).pipe(Stream.take(1), Stream.runCollect),
            )
            yield* Effect.sleep(50)
            const ownerAccepted = yield* useOwner.pipe(clientLayers(started.wsUrl))
            const seen = yield* Fiber.join(listening)
            return {
              listed,
              accepted,
              ownerAccepted,
              seen: Array.from(seen)
                .map((event) => JSON.stringify(event))
                .join('\n'),
            }
          })
          const joined = yield* useJoined.pipe(
            clientLayers('ws://' + new URL(started.origin).host + '/ui?join=' + join),
          )

          // An invitation types in the session but cannot hand the run on.
          const refusedShare = yield* Effect.promise(() =>
            httpCall(started.origin + '/share?label=Mallory', 'POST', joinedCookie),
          )
          const anonymous = yield* Effect.promise(() =>
            attemptSocket('ws://' + new URL(started.origin).host + '/ui'),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return {
            status: created.status,
            shared,
            exchangedStatus: exchanged.status,
            joined,
            refusedShare: refusedShare.status,
            anonymous: anonymous.status,
          }
        }),
      ),
    )

    expect(observed.status).toBe(201)
    expect(observed.shared.label).toBe('Alice')
    expect(observed.exchangedStatus).toBe(303)
    expect(observed.joined.listed.initial).toBe('a')
    expect(observed.joined.listed.opened).toEqual(['a'])
    expect(observed.joined.accepted).toBe(true)
    expect(observed.joined.ownerAccepted).toBe(true)
    expect(observed.joined.seen).toContain('hello from the owner')
    expect(observed.refusedShare).toBe(403)
    expect(observed.anonymous).toBe(401)
    // Both people's lines landed on the one host the session owns, so the log
    // still has one writer and the store still holds one session.
    expect(web.hosts.size).toBe(1)
    expect(
      web.hosts
        .get('a')
        ?.commands.map((command) => (command.kind === 'submit' ? command.text : command.kind)),
    ).toEqual(['hello from Alice', 'hello from the owner'])
    await rm(root, { recursive: true, force: true })
  })

  test('cutting an invitation closes its page and refuses the link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-cut-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const web = makeWeb('a')

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* start(root, web, makeSettings())
          const created = yield* Effect.promise(() =>
            httpCall(started.origin + '/share?label=Bob', 'POST', started.cookie),
          )
          // The list names the live invitation and the link the owner hands over.
          const liveList = yield* Effect.promise(() =>
            httpCall(started.origin + '/share', 'GET', started.cookie),
          )
          const shared = sharedInvitation(created.body)
          const join = new URL(shared.url).searchParams.get('join')
          if (join === null) throw new Error('the share link carries no invitation')
          const exchanged = yield* Effect.promise(() => httpGet(shared.url))
          const joinedCookie = exchanged.setCookie?.split(';')[0]
          if (joinedCookie === undefined) throw new Error('joining set no cookie')

          const socket = new WebSocket('ws://' + new URL(started.origin).host + '/ui', {
            headers: { cookie: joinedCookie },
          })
          const opened = new Promise<boolean>((resolve) => {
            socket.once('open', () => resolve(true))
            socket.once('error', () => resolve(false))
          })
          const closed = new Promise<number>((resolve) => {
            socket.once('close', (code) => resolve(code))
          })
          const live = yield* Effect.promise(() => opened)
          const cut = yield* Effect.promise(() =>
            httpCall(started.origin + '/share/' + shared.id, 'DELETE', started.cookie),
          )
          const closeCode = yield* Effect.promise(() => closed)
          const retry = yield* Effect.promise(() =>
            attemptSocket('ws://' + new URL(started.origin).host + '/ui?join=' + join),
          )
          const stale = yield* Effect.promise(() => httpCall(shared.url, 'GET'))
          const listed = yield* Effect.promise(() =>
            httpCall(started.origin + '/share', 'GET', started.cookie),
          )
          yield* Deferred.succeed(started.stop, undefined)
          return {
            live,
            cut: cut.status,
            closeCode,
            retry: retry.status,
            stale: stale.status,
            liveList: liveList.body,
            listed: listed.body,
          }
        }),
      ),
    )

    expect(observed).toEqual({
      live: true,
      cut: 200,
      closeCode: 4001,
      retry: 401,
      stale: 401,
      liveList: expect.stringContaining('"label":"Bob"'),
      listed: '{"items":[]}',
    })
    expect(observed.liveList).toContain('/?join=')
    await rm(root, { recursive: true, force: true })
  })
})
