import { Data, Deferred, Duration, Effect, Option, Schema } from 'effect'
import { JsonRpcResponseSchema } from './jsonrpc.ts'
import { dispatchJsonRpc, type DispatchResult } from './dispatcher.ts'
import type { AcpHandlerRegistry } from './methods.ts'

/** A request the server sent that the editor never answered in time. */
export class AcpTimeout extends Data.TaggedError('AcpTimeout')<{
  readonly method: string
  readonly timeoutMs: number
}> {}

/** An editor that answered a server request with a JSON-RPC error. */
export class AcpRequestFailed extends Data.TaggedError('AcpRequestFailed')<{
  readonly method: string
  readonly code: number
  readonly message: string
}> {}

export type AcpFailure = AcpTimeout | AcpRequestFailed

/**
 * What a session handler may say to the editor: a notification that needs no
 * answer, or a request that does. Ids are the connection's business.
 */
export interface AcpClient {
  readonly notify: (method: string, params: unknown) => Effect.Effect<void>
  readonly request: (
    method: string,
    params: unknown,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<unknown, AcpFailure>
}

export interface AcpConnection extends AcpClient {
  /** Reads one line; a response settles a server request and owns no answer of its own. */
  readonly dispatch: (line: string) => Effect.Effect<DispatchResult>
  /** How many server requests wait for an answer right now. */
  readonly pending: () => number
}

/** A turn may wait for a human at an editor; long enough to read, short enough not to hang. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000

const lineOf = (value: unknown): string => JSON.stringify(value)

/**
 * Speaks JSON-RPC over a line writer. It keeps the ids of the requests the
 * server sent and settles them from the lines the peer writes back, so a
 * handler can ask the editor a question and keep running.
 */
export const makeAcpConnection = (input: {
  readonly registry: AcpHandlerRegistry
  readonly write: (line: string) => void
}): AcpConnection => {
  const pending = new Map<number, Deferred.Deferred<unknown, AcpRequestFailed>>()
  let nextId = 1

  const notify = (method: string, params: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      input.write(lineOf({ jsonrpc: '2.0', method, params }))
    })

  const request = (
    method: string,
    params: unknown,
    options: { readonly timeoutMs?: number } = {},
  ): Effect.Effect<unknown, AcpFailure> =>
    Effect.gen(function* () {
      const id = nextId
      nextId += 1
      const gate = yield* Deferred.make<unknown, AcpRequestFailed>()
      pending.set(id, gate)
      yield* Effect.sync(() => {
        input.write(lineOf({ jsonrpc: '2.0', id, method, params }))
      })
      const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
      const answered = yield* Deferred.await(gate).pipe(
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id)
          }),
        ),
      )
      return yield* Option.isNone(answered)
        ? Effect.fail(new AcpTimeout({ method, timeoutMs }))
        : Effect.succeed(answered.value)
    })

  /**
   * Matches one response line to the request that asked it. Anything else —
   * a notification, a request, a malformed line — is left to the dispatcher.
   */
  const settle = (parsed: unknown): boolean => {
    if (!Schema.is(JsonRpcResponseSchema)(parsed)) return false
    if (typeof parsed.id !== 'number') return false
    const gate = pending.get(parsed.id)
    if (gate === undefined) return false
    pending.delete(parsed.id)
    // The error branch is the peer refusing to answer; the waiter reads it as a failure.
    const outcome: Effect.Effect<unknown, AcpRequestFailed> =
      'error' in parsed
        ? Effect.fail(
            new AcpRequestFailed({
              method: 'unknown',
              code: parsed.error.code,
              message: parsed.error.message,
            }),
          )
        : Effect.succeed(parsed.result)
    Deferred.doneUnsafe(gate, outcome)
    return true
  }

  const dispatch = (line: string): Effect.Effect<DispatchResult> =>
    Effect.promise(async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return dispatchJsonRpc(input.registry, line)
      }
      if (settle(parsed)) return null
      return dispatchJsonRpc(input.registry, line)
    })

  return {
    notify,
    request,
    dispatch,
    pending: () => pending.size,
  }
}
