import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { Effect, Layer, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { sendCommand } from '@jozo-harness/ui-protocol'
import { UiRpcs, type CommandView } from '../shared/rpc.ts'
import { makeWebProtocol, type Connection } from './protocol.ts'
import { applyMeta, readMeta, sessionActionOf, withMeta } from './session-meta.ts'
import {
  makeSessionRegistry,
  type OpenSession,
  type SessionFactory,
  type SessionRegistry,
} from './sessions.ts'
import { searchWorkspaceFiles } from './files.ts'
import { branchOf } from './git-branch.ts'
import type { SettingsPort } from './settings.ts'
import { staticResponse } from './static.ts'
import type { WorkspacesPort } from './workspaces.ts'

export const UI_PATH = '/ui'

export interface ServeWebOptions {
  /** The session a page opens when it names none; absent while the server holds none. */
  readonly initial?: OpenSession
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
  readonly onReady: (url: string) => void
  /** Completes to stop the server, as SIGINT does. */
  readonly interrupt?: Effect.Effect<void>
}

const handlersOf = (
  registry: SessionRegistry,
  settings: SettingsPort,
  workspaces: WorkspacesPort,
  commands: () => ReadonlyArray<CommandView>,
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
        const session = yield* registry.open(sessionId, cwd)
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
        // A running core owns its log; deleting the directory under it is not a
        // rename but a race with the next append. The reader stops it first.
        if (action.kind === 'delete' && registry.hostOf(sessionId) !== undefined) {
          return yield* Effect.fail('stop the session before deleting it')
        }
        const view = yield* settings.read()
        yield* sessionActionOf(view.sessionRoot, sessionId, action)
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

/** Answers one HTTP request: the socket path refuses plain HTTP, everything else is a file. */
const respondTo = async (
  request: IncomingMessage,
  response: ServerResponse,
  staticRoot: string,
): Promise<void> => {
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

/**
 * Serves the sessions of one profile: the browser app, the RPC socket, and
 * nothing else. Binds to loopback only; there is no authentication.
 */
export const serveWeb = (options: ServeWebOptions): Effect.Effect<number> =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeSessionRegistry({
        ...(options.initial === undefined ? {} : { initial: options.initial }),
        factory: options.factory,
      })
      const { protocol, attach } = yield* makeWebProtocol
      const connections = new Map<WebSocket, Connection>()

      const server = createServer((request, response) => {
        void respondTo(request, response, options.staticRoot).catch(() => {
          response.destroy()
        })
      })
      const sockets = new WebSocketServer({ noServer: true })
      server.on('upgrade', (request, socket, head) => {
        if (pathOf(request) !== UI_PATH) {
          socket.destroy()
          return
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
          const connection = attach((text) => client.send(text))
          connections.set(client, connection)
          client.on('message', (data) => connection.message(payloadOf(data)))
          client.on('close', () => {
            connection.close()
            connections.delete(client)
          })
        })
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
      // Our schemas need no decoding services, but Effect types a stream RPC's
      // service requirement as `unknown`; the layer is pinned to what it is.
      const rpc: Layer.Layer<never> = RpcServer.layer(UiRpcs).pipe(
        Layer.provide(handlersOf(registry, options.settings, options.workspaces, options.commands)),
        Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
      ) as unknown as Layer.Layer<never>
      yield* Effect.forkScoped(Layer.launch(rpc))
      options.onReady('http://127.0.0.1:' + String(port) + '/')
      return options.interrupt === undefined
        ? yield* Effect.never
        : yield* options.interrupt.pipe(Effect.as(130))
    }),
  ).pipe(Effect.provide(RpcSerialization.layerJson))
