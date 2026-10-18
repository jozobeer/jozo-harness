import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { Effect, Layer, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { sendCommand } from '@jozo-harness/ui-protocol'
import { UiRpcs } from '../shared/rpc.ts'
import { makeWebProtocol, type Connection } from './protocol.ts'
import {
  makeSessionRegistry,
  type OpenSession,
  type SessionFactory,
  type SessionRegistry,
} from './sessions.ts'
import type { SettingsPort } from './settings.ts'
import { staticResponse } from './static.ts'

export const UI_PATH = '/ui'

export interface ServeWebOptions {
  /** The session a page opens when it names none; absent while the server holds none. */
  readonly initial?: OpenSession
  /** Opens the rest: a page may ask for any session the store holds. */
  readonly factory: SessionFactory
  /** What the page may read and change about the run behind it. */
  readonly settings: SettingsPort
  /** 0 picks a free port; the chosen one arrives through `onReady`. */
  readonly port: number
  /** Where the browser app to serve sits; the caller owns where its tree keeps it. */
  readonly staticRoot: string
  readonly onReady: (url: string) => void
  /** Completes to stop the server, as SIGINT does. */
  readonly interrupt?: Effect.Effect<void>
}

const handlersOf = (registry: SessionRegistry, settings: SettingsPort) =>
  UiRpcs.toLayer({
    sessions: () =>
      registry.list().pipe(
        Effect.map((items) => ({ initial: registry.initial, items, opened: registry.openedIds() })),
        Effect.mapError((error) => error.message),
      ),
    open: ({ sessionId }) =>
      registry.open(sessionId).pipe(
        Effect.map((session) => session.summary),
        Effect.mapError((error) => error.message),
      ),
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
        Layer.provide(handlersOf(registry, options.settings)),
        Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
      ) as unknown as Layer.Layer<never>
      yield* Effect.forkScoped(Layer.launch(rpc))
      options.onReady('http://127.0.0.1:' + String(port) + '/')
      return options.interrupt === undefined
        ? yield* Effect.never
        : yield* options.interrupt.pipe(Effect.as(130))
    }),
  ).pipe(Effect.provide(RpcSerialization.layerJson))
