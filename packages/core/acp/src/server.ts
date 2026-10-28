import { Effect, Exit, Scope, Schema, Stream } from 'effect'
import { makeAcpConnection, type AcpClient, type AcpConnection } from './connection.ts'
import { JSON_RPC_ERROR, JsonRpcFault } from './jsonrpc.ts'
import {
  ACP_PROTOCOL_VERSION,
  makeAcpHandlerRegistry,
  type SessionPromptResult,
} from './methods.ts'

const InitializeParamsSchema = Schema.Struct({ protocolVersion: Schema.Int })
const SessionNewParamsSchema = Schema.Struct({ cwd: Schema.String })
const SessionPromptParamsSchema = Schema.Struct({
  sessionId: Schema.String,
  prompt: Schema.Array(Schema.String),
})
const SessionCancelParamsSchema = Schema.Struct({ sessionId: Schema.String })

/**
 * One session an editor drives. The host owns a turn: prompt resolves when the
 * turn that accepted the text has ended, and cancel stops it.
 */
export interface AcpSessionHost {
  readonly id: string
  readonly prompt: (text: string) => Effect.Effect<SessionPromptResult, Error>
  readonly cancel: () => Effect.Effect<void>
  /** Releases the session; the server also closes it when the process ends. */
  readonly close: () => Effect.Effect<void>
}

/**
 * Creates sessions on demand. The client is handed in so the host can ask the
 * editor when a tool needs permission; the port never sees transport details.
 */
export interface AcpSessionPort {
  readonly open: (
    cwd: string,
    client: AcpClient,
  ) => Effect.Effect<AcpSessionHost, Error, Scope.Scope>
}

export interface AcpServer {
  readonly connection: AcpConnection
  /** Closes every session this server opened. */
  readonly close: () => Effect.Effect<void>
}

export interface MakeAcpServerOptions {
  readonly connection: AcpConnection
  readonly sessions: AcpSessionPort
  /** What the editor shows as the agent's name; jzh unless a caller says otherwise. */
  readonly agentName?: string
}

const decode = <A>(
  schema: Schema.Schema<A> & Schema.ConstraintDecoder<unknown>,
  value: unknown,
): A => Schema.decodeUnknownSync(schema)(value)

const unknownSession = (id: string): JsonRpcFault =>
  new JsonRpcFault(JSON_RPC_ERROR.invalidParams, 'Unknown session: ' + id)

/**
 * Answers the four ACP methods over one connection. A session lives in a scope
 * the server owns, so an editor that goes away cannot leak a running core.
 */
export const makeAcpServer = (
  options: MakeAcpServerOptions,
): Effect.Effect<AcpServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const connection = options.connection
    // The connection is the one reader of the wire, so its table is the one a
    // method must land in; a second table would answer every method as missing.
    const registry = connection.registry
    const opened = new Map<string, AcpSessionHost>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...opened.values()], (host) => host.close(), { discard: true }),
    )

    const hostOf = (id: string): AcpSessionHost => {
      const host = opened.get(id)
      if (host === undefined) throw unknownSession(id)
      return host
    }

    const sessionNew = async (params: unknown): Promise<unknown> => {
      const { cwd } = decode(SessionNewParamsSchema, params)
      const scope = Scope.makeUnsafe()
      try {
        const host = await Effect.runPromise(
          options.sessions.open(cwd, connection).pipe(Effect.provideService(Scope.Scope, scope)),
        )
        opened.set(host.id, host)
        return { sessionId: host.id }
      } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.void))
        throw cause
      }
    }

    registry.register('initialize', {
      params: InitializeParamsSchema,
      handle: (params: unknown) => {
        decode(InitializeParamsSchema, params)
        // The editor decides whether it can talk to this version; the answer is
        // what this server speaks, not a flattering echo of the request.
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentName: options.agentName ?? 'jozo-harness',
          agentCapabilities: { promptCapabilities: { image: false, audio: false } },
        }
      },
    })
    registry.register('session/new', {
      params: SessionNewParamsSchema,
      handle: sessionNew,
    })
    registry.register('session/prompt', {
      params: SessionPromptParamsSchema,
      handle: async (params: unknown) => {
        const prompt = decode(SessionPromptParamsSchema, params)
        const host = hostOf(prompt.sessionId)
        return Effect.runPromise(host.prompt(prompt.prompt.join('\n')))
      },
    })
    registry.register('session/cancel', {
      params: SessionCancelParamsSchema,
      handle: async (params: unknown) => {
        const cancel = decode(SessionCancelParamsSchema, params)
        await Effect.runPromise(hostOf(cancel.sessionId).cancel())
        return { cancelled: true }
      },
    })

    return {
      connection,
      close: () => Effect.forEach([...opened.values()], (host) => host.close(), { discard: true }),
    }
  })

export interface ServeAcpOptions {
  /** The bytes an editor writes; one JSON-RPC message per line. */
  readonly input: AsyncIterable<string | Uint8Array>
  /** The line writer, which must carry nothing but JSON-RPC. */
  readonly write: (line: string) => void
  readonly sessions: AcpSessionPort
  readonly agentName?: string
}

/**
 * Runs the stdio transport until the editor closes the input. A turn may take
 * minutes, so every line is answered on its own fiber: a cancel must be read
 * while a prompt is still waiting.
 */
export const serveAcp = (options: ServeAcpOptions): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = makeAcpHandlerRegistry()
    const connection = makeAcpConnection({ registry, write: options.write })
    yield* makeAcpServer({
      connection,
      sessions: options.sessions,
      ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
    })
    const encoder = new TextEncoder()
    const lines = Stream.fromAsyncIterable(options.input, () => new Error('stdin failed')).pipe(
      Stream.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk)),
      Stream.decodeText(),
      Stream.splitLines,
    )
    yield* Stream.runForEach(lines, (line) => {
      if (line.trim() === '') return Effect.void
      // Each answer is written whole; a rejected dispatch is a bug, not a
      // message an editor could act on, so the line is dropped rather than
      // bringing the server down.
      return Effect.forkScoped(
        connection.dispatch(line).pipe(
          Effect.flatMap((answer) =>
            answer === null ? Effect.void : Effect.sync(() => options.write(answer)),
          ),
          Effect.catchCause(() => Effect.void),
        ),
      )
    }).pipe(Effect.catchCause(() => Effect.void))
  })
