import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { Effect, Layer, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { sendCommand } from '@jozo-harness/ui-protocol'
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
import { searchWorkspaceFiles } from './files.ts'
import { branchOf } from './git-branch.ts'
import type { SettingsPort } from './settings.ts'
import { staticResponse } from './static.ts'
import { makeStoreEvents, type StoreEvents } from './store-events.ts'
import type { WorkspacesPort } from './workspaces.ts'

export const UI_PATH = '/ui'

/** Where to open the page: the loopback address, and the published one when it has one. */
export interface ReadyUrls {
  readonly local: string
  readonly public?: string
}

export interface ServeWebOptions {
  /** The session a page opens when it names none; absent while the server holds none. */
  readonly initial?: InitialSession
  /** Opens the rest: a page may ask for any session the store holds. */
  readonly factory: SessionFactory
  /** What the page may read and change about the run behind it. */
  readonly settings: SettingsPort
  /** The folders a page may start a session in. */
  readonly workspaces: WorkspacesPort
  /** What the run can be told before any session exists: the blank page's own list. */
  readonly commands: () => ReadonlyArray<CommandView>
  /** 0 picks a free port; the chosen one arrives through `onReady`. */
  readonly port: number
  /** Where the browser app to serve sits; the caller owns where its tree keeps it. */
  readonly staticRoot: string
  /**
   * The https origin a reverse proxy publishes; its Host and Origin join the
   * loopback ones in the gate, and its address becomes the second ready URL.
   */
  readonly publicUrl?: PublicOrigin
  readonly onReady: (urls: ReadyUrls) => void
  /** Completes to stop the server, as SIGINT does. */
  readonly interrupt?: Effect.Effect<void>
}

const handlersOf = (
  registry: SessionRegistry,
  settings: SettingsPort,
  workspaces: WorkspacesPort,
  commands: () => ReadonlyArray<CommandView>,
  store: StoreEvents,
) =>
  UiRpcs.toLayer({
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
      return host === undefined
        ? Effect.succeed(false)
        : sendCommand(host, command).pipe(
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
        return yield* searchWorkspaceFiles(cwd, query)
      }).pipe(Effect.mapError((error) => (typeof error === 'string' ? error : error.message))),
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

/** One frame from the socket, in the two shapes the protocol decodes. */
const payloadOf = (data: RawData): Uint8Array | string => {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}

/** The path a request asked for, without its query. */
const pathOf = (request: IncomingMessage): string =>
  new URL(request.url ?? '/', 'http://127.0.0.1').pathname

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
  port: number,
  publicOrigin: PublicOrigin | undefined,
  token: string,
  codes: CodeExchange,
): Promise<void> => {
  // A page served under another name could read this one through a rebinding
  // proxy; the name the request asked for must be one this server answers to.
  if (!hostAllowed(request.headers.host, port, publicOrigin)) {
    endWith(response, 403, 'forbidden')
    return
  }
  if (exchangeCode(request, response, token, codes, secureExchange(request, publicOrigin))) return
  const path = pathOf(request)
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
 * Binds to loopback; the ready URL carries a one-time code that the first page
 * load trades for a strict HttpOnly cookie, and a foreign Host or Origin is
 * refused before the handshake.
 */
export const serveWeb = (options: ServeWebOptions): Effect.Effect<number> =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeSessionRegistry({
        ...(options.initial === undefined ? {} : { initial: options.initial }),
        factory: options.factory,
      })
      const { protocol, attach } = yield* makeWebProtocol
      const store = makeStoreEvents()
      const connections = new Map<WebSocket, Connection>()
      // One token per run, kept out of the ready URL: that URL carries a code
      // which trades for the token in an HttpOnly cookie and then dies.
      const token = randomBytes(32).toString('hex')
      const codes = codeExchange(() => Date.now())
      const publicOrigin = options.publicUrl
      // The chosen port is known only once the listener is up; requests arrive after.
      let boundPort = options.port

      const server = createServer((request, response) => {
        void respondTo(
          request,
          response,
          options.staticRoot,
          boundPort,
          publicOrigin,
          token,
          codes,
        ).catch(() => {
          response.destroy()
        })
      })
      const sockets = new WebSocketServer({ noServer: true })

      /** Why this handshake is refused; undefined when the gate lets it through. */
      const refusalOf = (
        request: IncomingMessage,
      ): { readonly status: number; readonly message: string } | undefined => {
        if (!hostAllowed(request.headers.host, boundPort, publicOrigin)) {
          return { status: 403, message: 'forbidden host' }
        }
        if (!originAllowed(request.headers.origin, boundPort, publicOrigin)) {
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

      server.on('upgrade', (request, socket, head) => {
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
      })

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const client of sockets.clients) client.terminate()
          sockets.close()
          // A keep-alive connection would hold the listener open past the scope.
          server.closeAllConnections()
          server.close()
        }),
      )
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            server.once('error', reject)
            server.listen(options.port, '127.0.0.1', () => {
              const address = server.address()
              resolve(typeof address === 'object' && address !== null ? address.port : options.port)
            })
          }),
      )
      boundPort = port
      // Our schemas need no decoding services, but Effect types a stream RPC's
      // service requirement as `unknown`; the layer is pinned to what it is.
      const rpc: Layer.Layer<never> = RpcServer.layer(UiRpcs).pipe(
        Layer.provide(
          handlersOf(registry, options.settings, options.workspaces, options.commands, store),
        ),
        Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
      ) as unknown as Layer.Layer<never>
      yield* Effect.forkScoped(Layer.launch(rpc))
      const local = 'http://127.0.0.1:' + String(port) + '/?code=' + codes.issue()
      // Each address gets its own code: opening the page on one must not spend
      // the link printed for the other.
      options.onReady(
        publicOrigin === undefined
          ? { local }
          : { local, public: publicOrigin.origin + '/?code=' + codes.issue() },
      )
      return options.interrupt === undefined
        ? yield* Effect.never
        : yield* options.interrupt.pipe(Effect.as(130))
    }),
  ).pipe(Effect.provide(RpcSerialization.layerJson))
