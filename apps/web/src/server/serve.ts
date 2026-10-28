import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { Effect, Layer, Option, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import {
  artifactRootOf,
  installHostScheduleRuns,
  scheduleRuleOf,
  scheduleTitleOf,
  scheduleViewOf,
  type ScheduleStore,
} from '@jozo-harness/tools-tier1'
import { sendCommand, type SessionError, type SessionEvent } from '@jozo-harness/ui-protocol'
import { attachmentRootOf, saveAttachment } from '@jozo-harness/session/attachment-store'
import { UiRpcs, type CommandView } from '../shared/rpc.ts'
import {
  authCookie,
  COOKIE_NAME,
  codeExchange,
  codeFromUrl,
  cookieOf,
  hostAllowed,
  originAllowed,
  tokenFromUrl,
  tokenMatches,
  type CodeExchange,
  type PublicOrigin,
} from './auth.ts'
import { makeWebProtocol, type Connection } from './protocol.ts'
import { applyMeta, readMeta, sessionActionOf, withMeta } from './session-meta.ts'
import {
  makeSessionRegistry,
  type InitialSession,
  type SessionFactory,
  type SessionRegistry,
} from './sessions.ts'
import { answerArtifact } from './artifacts.ts'
import { answerSessionExport } from './session-export.ts'
import { answerPlugins, type PluginsPort } from './plugins.ts'
import { answerWebhook, type WebhookGate, type WebhookRule } from './webhooks.ts'
import { searchWorkspaceFiles } from './files.ts'
import {
  resolveReferences,
  sessionCandidateTargets,
  type SessionDigestSource,
} from './references.ts'
import { branchOf } from './git-branch.ts'
import type { SettingsPort } from './settings.ts'
import { staticResponse } from './static.ts'
import { makeStoreEvents, type StoreEvents } from './store-events.ts'
import type { TailnetAddresses } from './tailnet.ts'
import type { WorkspacesPort } from './workspaces.ts'

export const UI_PATH = '/ui'

/** Where to open the page: loopback, each detected tailnet address, and the published one. */
export interface ReadyUrls {
  readonly local: string
  /** The tailnet addresses, each with its own code; empty when none was detected. */
  readonly tailnet: ReadonlyArray<string>
  readonly public?: string
}

export interface ServeWebOptions {
  /** The session a page opens when it names none; absent while the server holds none. */
  readonly initial?: InitialSession
  /** Opens the rest: a page may ask for any session the store holds. */
  readonly factory: SessionFactory
  /** The host's schedules: one store for every session this server serves. */
  readonly schedules: ScheduleStore
  /** What the page may read and change about the run behind it. */
  readonly settings: SettingsPort
  /** The folders a page may start a session in. */
  readonly workspaces: WorkspacesPort
  /**
   * Rules an external event may start a session with. Absent refuses every
   * /hooks/ path, so the route is off until the settings file names a rule.
   */
  readonly webhooks?: ReadonlyArray<WebhookRule>
  /**
   * One session's log, as an @ reference may quote it. The resolver decides which
   * sessions a message can reach; this only reads the one it names.
   */
  readonly readSessionEvents: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<SessionEvent>, SessionError>
  /** What the run can be told before any session exists: the blank page's own list. */
  readonly commands: () => ReadonlyArray<CommandView>
  /**
   * The rows this run was built from, the optional bundles, and the failed
   * wirings. The page lists them and writes one change at a time.
   */
  readonly plugins: PluginsPort
  /** 0 picks a free port; the chosen one arrives through `onReady`. */
  readonly port: number
  /** Where the browser app to serve sits; the caller owns where its tree keeps it. */
  readonly staticRoot: string
  /**
   * The https origin a reverse proxy publishes; its Host and Origin join the
   * loopback ones in the gate, and its address becomes the second ready URL.
   */
  readonly publicUrl?: PublicOrigin
  /**
   * The addresses Tailscale named for this machine. They join the gate, and
   * the IPv4 address becomes a second listener at the same port; each name is
   * a ready URL with its own code. Absent keeps the server on loopback.
   */
  readonly tailnet?: TailnetAddresses
  readonly onReady: (urls: ReadyUrls) => void
  /** Completes to stop the server, as SIGINT does. */
  readonly interrupt?: Effect.Effect<void>
}

const handlersOf = (
  registry: SessionRegistry,
  settings: SettingsPort,
  workspaces: WorkspacesPort,
  readSessionEvents: (id: string) => Effect.Effect<ReadonlyArray<SessionEvent>, SessionError>,
  commands: () => ReadonlyArray<CommandView>,
  store: StoreEvents,
  schedules: ScheduleStore,
) => {
  /** The sessions an @ reference may name: the store's list, and one log at a time. */
  const digests: SessionDigestSource = { list: () => registry.list(), events: readSessionEvents }
  return UiRpcs.toLayer({
    sessions: () =>
      Effect.gen(function* () {
        const view = yield* settings.read()
        const meta = yield* readMeta(view.sessionRoot)
        const items = yield* registry.list()
        return {
          initial: registry.initial,
          items: applyMeta(items, meta),
          opened: registry.openedIds(),
        }
      }).pipe(Effect.mapError((error) => error.message)),
    open: ({ sessionId, cwd }) =>
      Effect.gen(function* () {
        // Resuming a session somebody already opened changes nothing another
        // page reads; opening one more is the store change every page needs.
        const known = sessionId !== undefined && registry.sessionOf(sessionId) !== undefined
        const session = yield* registry.open(sessionId, cwd)
        if (!known) store.notify()
        const view = yield* settings.read()
        const meta = yield* readMeta(view.sessionRoot)
        return withMeta(session.summary, meta[session.summary.id])
      }).pipe(Effect.mapError((error) => error.message)),
    branch: ({ sessionId }) =>
      Effect.gen(function* () {
        // The blank page has no workspace yet; an id nobody opened is a request error.
        if (sessionId === '') return null
        const session = registry.sessionOf(sessionId)
        if (session === undefined) return yield* Effect.fail('the session is not open')
        return yield* branchOf(session.summary.cwd)
      }),
    sessionAction: ({ sessionId, action }) =>
      Effect.gen(function* () {
        if (action.kind === 'delete') {
          const open = registry.sessionOf(sessionId)
          // A core that is working owns its log: closing it mid-turn would cut a
          // write. The page already offers a stop for each kind of work, so only
          // that moment is refused, and the strip says what to stop.
          if (open?.busy() === true) {
            return yield* Effect.fail(
              'stop the running turn, job, or subagent, then delete the session',
            )
          }
          // An idle open session is safe to release: wait for its scope to close
          // before the directory goes, so the delete is never a race with a write.
          yield* registry.close(sessionId)
        }
        const view = yield* settings.read()
        yield* sessionActionOf(view.sessionRoot, sessionId, action)
        // A rename, a pin, or a delete is another device's row as well.
        store.notify()
        return true
      }).pipe(Effect.mapError((error) => (typeof error === 'string' ? error : error.message))),
    command: ({ sessionId, command }) => {
      const host = registry.hostOf(sessionId)
      if (host === undefined) return Effect.succeed(false)
      // A submitted line's @words are read here, at the one boundary that holds
      // the workspace and the store, so every transport sends the same structure.
      const cwd = registry.sessionOf(sessionId)?.summary.cwd
      const prepared =
        command.kind !== 'submit' || cwd === undefined
          ? Effect.succeed(command)
          : resolveReferences(cwd, command.text, digests).pipe(
              Effect.map((references) =>
                references.length === 0 ? command : { ...command, references },
              ),
            )
      return prepared.pipe(
        Effect.flatMap((one) => sendCommand(host, one)),
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      )
    },
    events: ({ sessionId }) => {
      const host = registry.hostOf(sessionId)
      return host === undefined ? Stream.fail('the session is not open') : host.events
    },
    storeChanged: () => store.subscribe(),
    state: ({ sessionId }) => {
      const view = registry.stateOf(sessionId)
      return view === undefined ? Effect.fail('the session is not open') : Effect.succeed(view)
    },
    scheduleCreate: (payload) =>
      Effect.gen(function* () {
        const session = registry.sessionOf(payload.sessionId)
        if (session === undefined) return yield* Effect.fail('the session is not open')
        const list = yield* Effect.try({
          // The model's tool builds the same record from the same checks, so a
          // schedule either side creates is one the other lists.
          try: () => {
            session.adoptSchedules?.()
            if (payload.prompt.trim() === '') throw new Error('prompt is required')
            const now = schedules.now()
            const rule = scheduleRuleOf(payload, now)
            const title = scheduleTitleOf(payload.title)
            schedules.write({
              kind: 'created',
              schedule: {
                id: schedules.nextId(),
                sessionId: payload.sessionId,
                rule,
                prompt: payload.prompt,
                ...(title === undefined ? {} : { title }),
                createdAt: now,
              },
            })
            store.notify()
            return schedules.list(payload.sessionId).map(scheduleViewOf)
          },
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        })
        return list
      }),
    schedulePause: ({ sessionId, id, paused }) =>
      Effect.gen(function* () {
        const list = yield* Effect.try({
          try: () => {
            const current = schedules.find(id)
            if (current === undefined || current.sessionId !== sessionId) {
              throw new Error('no schedule with that id in this session')
            }
            schedules.write({ kind: 'updated', schedule: { ...current, paused } })
            store.notify()
            return schedules.list(sessionId).map(scheduleViewOf)
          },
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        })
        return list
      }),
    scheduleDelete: ({ sessionId, id }) =>
      Effect.gen(function* () {
        const list = yield* Effect.try({
          try: () => {
            const current = schedules.find(id)
            if (current === undefined || current.sessionId !== sessionId) {
              throw new Error('no schedule with that id in this session')
            }
            schedules.write({ kind: 'deleted', id })
            store.notify()
            return schedules.list(sessionId).map(scheduleViewOf)
          },
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        })
        return list
      }),
    commands: ({ sessionId }) => {
      // The blank page has no session to ask, so the run answers for it: the
      // first line typed must complete before the session that receives it exists.
      if (sessionId === '') return Effect.succeed(commands())
      const list = registry.commandsOf(sessionId)
      return list === undefined ? Effect.fail('the session is not open') : Effect.succeed(list)
    },
    files: ({ sessionId, query }) =>
      Effect.gen(function* () {
        // The session names its own directory; the blank page has none yet, so
        // the run's own is what the first line completes against.
        const cwd =
          sessionId === ''
            ? (yield* settings.read()).cwd
            : registry.sessionOf(sessionId)?.summary.cwd
        if (cwd === undefined) return yield* Effect.fail('the session is not open')
        const paths = yield* searchWorkspaceFiles(cwd, query)
        // Only the sessions this workspace may read are offered, so a candidate
        // is always one a message can actually attach.
        const sessions = yield* sessionCandidateTargets(cwd, query, digests)
        return [...paths, ...sessions]
      }).pipe(Effect.mapError((error) => (typeof error === 'string' ? error : error.message))),
    attach: ({ name, mediaType, data }) =>
      Effect.gen(function* () {
        const view = yield* settings.read()
        const bytes = Buffer.from(data, 'base64')
        return yield* saveAttachment(attachmentRootOf(view.sessionRoot), {
          name,
          mediaType,
          data: bytes,
        })
      }).pipe(Effect.mapError((error) => (error instanceof Error ? error.message : String(error)))),
    jobDetail: ({ sessionId, id }) => {
      const session = registry.sessionOf(sessionId)
      return session === undefined
        ? Effect.fail('the session is not open')
        : session.jobOutput(id).pipe(Effect.mapError((error) => error.message))
    },
    stopJob: ({ sessionId, id }) => {
      const session = registry.sessionOf(sessionId)
      return session === undefined
        ? Effect.fail('the session is not open')
        : session.stopJob(id).pipe(
            Effect.as(true),
            Effect.mapError((error) => error.message),
          )
    },
    stopSubagent: ({ sessionId, id }) => {
      const session = registry.sessionOf(sessionId)
      return session === undefined
        ? Effect.fail('the session is not open')
        : session.stopSubagent(id).pipe(
            Effect.as(true),
            Effect.mapError((error) => error.message),
          )
    },
    workspaces: () => workspaces.list().pipe(Effect.mapError((error) => error.message)),
    browseDirectories: ({ path }) =>
      workspaces.browse(path).pipe(Effect.mapError((error) => error.message)),
    addWorkspace: ({ cwd }) =>
      workspaces.add(cwd).pipe(
        Effect.as(true),
        Effect.mapError((error) => error.message),
      ),
    settings: () => settings.read().pipe(Effect.mapError((error) => error.message)),
    models: () => settings.models().pipe(Effect.mapError((error) => error.message)),
    setModel: ({ model, remember }) =>
      settings.setModel(model, remember).pipe(
        Effect.as(true),
        Effect.mapError((error) => error.message),
      ),
    setEffort: ({ effort }) =>
      settings.setEffort(effort).pipe(
        Effect.as(true),
        Effect.mapError((error) => error.message),
      ),
  })
}

/** One frame from the socket, in the two shapes the protocol decodes. */
const payloadOf = (data: RawData): Uint8Array | string => {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}

/** The path a request asked for, without its query. */
const pathOf = (request: IncomingMessage): string =>
  new URL(request.url ?? '/', 'http://127.0.0.1').pathname

/** Starts one listener at the requested port, answering the port it actually bound. */
const listenAt = (server: Server, port: number, host: string): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })

/**
 * The ready URLs for the detected tailnet names. The address is the one the
 * listener bound, so the MagicDNS name carries the same port and each name
 * earns a code of its own.
 */
const tailnetUrlsAt = (
  port: number,
  tailnet: TailnetAddresses,
  issue: () => string,
): ReadonlyArray<string> =>
  [tailnet.ip, tailnet.dns]
    .filter((address): address is string => address !== undefined)
    .map((address) => 'http://' + address.toLowerCase() + ':' + String(port) + '/?code=' + issue())

/** No ready URL for an address nobody bound, so a printed link is one that answers. */
const tailnetReadyUrls = (
  tailnet: TailnetAddresses | undefined,
  port: number,
  issue: () => string,
): ReadonlyArray<string> => (tailnet === undefined ? [] : tailnetUrlsAt(port, tailnet, issue))

/**
 * Binds the detected tailnet address on the port loopback took. A failed bind
 * (the interface went away between detection and listen) closes the extra
 * listener and leaves the run on loopback.
 */
const listenTailnet = (
  server: Server,
  ip: string,
  port: number,
  tailnet: TailnetAddresses | undefined,
): Effect.Effect<TailnetAddresses | undefined> =>
  Effect.promise(() =>
    listenAt(server, port, ip).then(
      () => tailnet,
      () => {
        server.close()
        return undefined
      },
    ),
  )

/** The tailnet the gate may admit: only an address with a listener under it. */
const tailnetBinding = (
  server: Server | undefined,
  ip: string | undefined,
  port: number,
  tailnet: TailnetAddresses | undefined,
): Effect.Effect<TailnetAddresses | undefined> =>
  server === undefined || ip === undefined
    ? Effect.succeed<TailnetAddresses | undefined>(undefined)
    : listenTailnet(server, ip, port, tailnet)

const endWith = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

/**
 * Trades a startup code for the auth cookie and a redirect to a clean address.
 * The exchange happens before any page is served, so a code never sits in a URL
 * the browser could keep or hand on. False means this was not that request.
 */
const exchangeCode = (
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  codes: CodeExchange,
  secure: boolean,
): boolean => {
  const code = codeFromUrl(request.url ?? '')
  if (pathOf(request) !== '/' || code === undefined) return false
  if (!codes.redeem(code)) {
    endWith(response, 401, 'the code is expired or already used')
    return true
  }
  response.writeHead(303, {
    location: '/',
    'set-cookie': authCookie(token, secure),
    'cache-control': 'no-store',
  })
  response.end()
  return true
}

/**
 * True when the browser that repeats this cookie reached the page over https:
 * either the proxy says so, or the request names the published host, which is
 * only reachable through the https origin the command was given.
 */
const secureExchange = (
  request: IncomingMessage,
  publicOrigin: PublicOrigin | undefined,
): boolean =>
  request.headers['x-forwarded-proto'] === 'https' ||
  (publicOrigin !== undefined && request.headers.host?.toLowerCase() === publicOrigin.host)

/** Answers one HTTP request: the socket path refuses plain HTTP, everything else is a file. */
const respondTo = async (
  request: IncomingMessage,
  response: ServerResponse,
  staticRoot: string,
  artifactRoot: string | undefined,
  sessionRoot: string | undefined,
  port: number,
  publicOrigin: PublicOrigin | undefined,
  tailnet: TailnetAddresses | undefined,
  token: string,
  codes: CodeExchange,
  plugins: PluginsPort,
  readSessionEvents: (id: string) => Effect.Effect<ReadonlyArray<SessionEvent>, SessionError>,
  webhooks: WebhookGate,
): Promise<void> => {
  // A page served under another name could read this one through a rebinding
  // proxy; the name the request asked for must be one this server answers to.
  if (!hostAllowed(request.headers.host, port, publicOrigin, tailnet)) {
    endWith(response, 403, 'forbidden')
    return
  }
  if (exchangeCode(request, response, token, codes, secureExchange(request, publicOrigin))) return
  const path = pathOf(request)
  // A delivery comes from a service, so it is answered before the page routes and
  // outside their cookie and origin gate; its secret is checked in the route.
  if (await answerWebhook(request, response, path, webhooks)) return
  if (
    await answerArtifact(request, response, path, {
      root: artifactRoot,
      port,
      publicOrigin,
      tailnet,
      token,
      codes,
    })
  )
    return
  if (
    await answerSessionExport(request, response, path, {
      root: sessionRoot,
      events: readSessionEvents,
      port,
      publicOrigin,
      tailnet,
      token,
      codes,
    })
  )
    return
  if (
    await answerPlugins(request, response, path, {
      plugins,
      port,
      publicOrigin,
      tailnet,
      token,
      codes,
    })
  )
    return
  await answerPage(response, staticRoot, path)
}

/** Serves the browser app's own files; every other path is 404. */
const answerPage = async (
  response: ServerResponse,
  staticRoot: string,
  path: string,
): Promise<void> => {
  if (path === UI_PATH) {
    endWith(response, 426, 'websocket required')
    return
  }
  const answer = await staticResponse(staticRoot, path)
  if (answer === undefined) {
    endWith(response, 404, 'not found')
    return
  }
  response.writeHead(answer.status, Object.fromEntries(answer.headers))
  response.end(Buffer.from(await answer.arrayBuffer()))
}

/** Refuses a websocket handshake with a status the client can read. */
const refuseUpgrade = (socket: Duplex, status: number, message: string): void => {
  const body = message + '\n'
  const reason = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Forbidden'
  socket.end(
    'HTTP/1.1 ' +
      String(status) +
      ' ' +
      reason +
      '\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ' +
      String(Buffer.byteLength(body)) +
      '\r\n\r\n' +
      body,
  )
}

/**
 * Serves the sessions of one profile: the browser app and the RPC socket.
 * Binds to loopback, and to this machine's detected tailnet address when there
 * is one; the ready URL carries a one-time code that the first page load trades
 * for a strict HttpOnly cookie, and a foreign Host or Origin is refused before
 * the handshake.
 */
export const serveWeb = (options: ServeWebOptions): Effect.Effect<number> =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeSessionRegistry({
        ...(options.initial === undefined ? {} : { initial: options.initial }),
        factory: options.factory,
      })
      // The server owns the clock, not an agent: a schedule fires while its
      // session is closed or while the page shows another one. A delivery to a
      // session nobody opened is left due, so opening it later catches up.
      yield* installHostScheduleRuns({
        store: options.schedules,
        deliver: (schedule) => {
          const session =
            schedule.sessionId === undefined ? undefined : registry.sessionOf(schedule.sessionId)
          return session === undefined
            ? Effect.succeed(false)
            : (session.deliver?.(schedule) ?? Effect.succeed(false))
        },
        now: () => options.schedules.now(),
      })
      const { protocol, attach } = yield* makeWebProtocol
      const store = makeStoreEvents()
      // A delivery starts the same session a page's first line does: one core in
      // the rule's workspace, and one turn carrying the event. The route has no
      // cookie, so the rule's secret is what stands in for it.
      const webhooks: WebhookGate = {
        rules: options.webhooks ?? [],
        start: (rule, prompt) =>
          Effect.runPromise(
            registry.open(undefined, rule.cwd).pipe(
              Effect.tap(() => Effect.sync(() => store.notify())),
              Effect.flatMap((session) =>
                sendCommand(session.host, { kind: 'submit', text: prompt }).pipe(
                  Effect.as({ kind: 'started' as const, sessionId: session.summary.id }),
                ),
              ),
              Effect.catch(() => Effect.succeed({ kind: 'unavailable' as const })),
            ),
          ),
      }
      const connections = new Map<WebSocket, Connection>()
      // One token per run, kept out of the ready URL: that URL carries a code
      // which trades for the token in an HttpOnly cookie and then dies.
      const token = randomBytes(32).toString('hex')
      const codes = codeExchange(() => Date.now())
      const publicOrigin = options.publicUrl
      // The sessions root names the jzh home the artifacts sit beside; settings
      // that cannot be read leave the route answering as if the file were gone.
      const view = yield* options.settings.read().pipe(Effect.option)
      const sessionRoot = Option.match(view, {
        onNone: () => undefined,
        onSome: (read) => read.sessionRoot,
      })
      const artifactRoot = sessionRoot === undefined ? undefined : artifactRootOf(sessionRoot)
      // The chosen port is known only once the listeners are up; requests arrive after.
      let boundPort = options.port
      // A detected address joins the gate only once a listener waits there; a
      // bind that fails leaves the run on loopback rather than printing a dead URL.
      let tailnet: TailnetAddresses | undefined
      const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
        void respondTo(
          request,
          response,
          options.staticRoot,
          artifactRoot,
          sessionRoot,
          boundPort,
          publicOrigin,
          tailnet,
          token,
          codes,
          options.plugins,
          options.readSessionEvents,
          webhooks,
        ).catch(() => {
          response.destroy()
        })
      }
      const server = createServer(requestHandler)
      const detectedIp = options.tailnet?.ip
      const tailnetServer = detectedIp === undefined ? undefined : createServer(requestHandler)
      const sockets = new WebSocketServer({ noServer: true })

      /** Why this handshake is refused; undefined when the gate lets it through. */
      const refusalOf = (
        request: IncomingMessage,
      ): { readonly status: number; readonly message: string } | undefined => {
        if (!hostAllowed(request.headers.host, boundPort, publicOrigin, tailnet)) {
          return { status: 403, message: 'forbidden host' }
        }
        if (!originAllowed(request.headers.origin, boundPort, publicOrigin, tailnet)) {
          return { status: 403, message: 'forbidden origin' }
        }
        // A page repeats the cookie; a script may name the token or redeem a fresh
        // startup code, so an e2e can connect with the URL the command printed.
        const offered =
          cookieOf(request.headers.cookie, COOKIE_NAME) ?? tokenFromUrl(request.url ?? '')
        if (tokenMatches(offered, token)) return undefined
        return codes.peek(codeFromUrl(request.url ?? ''))
          ? undefined
          : { status: 401, message: 'a token or a code is required' }
      }

      /** Wires one accepted socket as the page's RPC connection. */
      const attachUi = (client: WebSocket): void => {
        const connection = attach((text) => client.send(text))
        connections.set(client, connection)
        client.on('message', (data) => connection.message(payloadOf(data)))
        client.on('close', () => {
          connection.close()
          connections.delete(client)
        })
      }

      const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        if (pathOf(request) !== UI_PATH) {
          socket.destroy()
          return
        }
        const refusal = refusalOf(request)
        if (refusal !== undefined) {
          refuseUpgrade(socket, refusal.status, refusal.message)
          return
        }
        sockets.handleUpgrade(request, socket, head, (client) => attachUi(client))
      }
      server.on('upgrade', onUpgrade)
      tailnetServer?.on('upgrade', onUpgrade)

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const client of sockets.clients) client.terminate()
          sockets.close()
          // A keep-alive connection would hold a listener open past the scope.
          for (const listener of [server, tailnetServer]) {
            listener?.closeAllConnections()
            listener?.close()
          }
        }),
      )
      boundPort = yield* Effect.promise(() => listenAt(server, options.port, '127.0.0.1'))
      tailnet = yield* tailnetBinding(tailnetServer, detectedIp, boundPort, options.tailnet)
      // Our schemas need no decoding services, but Effect types a stream RPC's
      // service requirement as `unknown`; the layer is pinned to what it is.
      const rpc: Layer.Layer<never> = RpcServer.layer(UiRpcs).pipe(
        Layer.provide(
          handlersOf(
            registry,
            options.settings,
            options.workspaces,
            options.readSessionEvents,
            options.commands,
            store,
            options.schedules,
          ),
        ),
        Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
      ) as unknown as Layer.Layer<never>
      yield* Effect.forkScoped(Layer.launch(rpc))
      const local = 'http://127.0.0.1:' + String(boundPort) + '/?code=' + codes.issue()
      // Each address gets its own code: opening the page on one must not spend
      // the link printed for the other.
      options.onReady({
        local,
        tailnet: tailnetReadyUrls(tailnet, boundPort, () => codes.issue()),
        ...(publicOrigin === undefined
          ? {}
          : { public: publicOrigin.origin + '/?code=' + codes.issue() }),
      })
      return options.interrupt === undefined
        ? yield* Effect.never
        : yield* options.interrupt.pipe(Effect.as(130))
    }),
  ).pipe(Effect.provide(RpcSerialization.layerJson))
