import { Data, Deferred, Duration, Effect, Option } from 'effect'
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
  /** The table the server registers its methods in. */
  readonly registry: AcpHandlerRegistry
  /** Reads one line; a response settles a server request and owns no answer of its own. */
  readonly dispatch: (line: string) => Effect.Effect<DispatchResult>
  /** How many server requests wait for an answer right now. */
  readonly pending: () => number
}

/** A turn may wait for a human at an editor; long enough to read, short enough not to hang. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000

const lineOf = (value: unknown): string => JSON.stringify(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** An answer, not a call: it has an id and a result or error but no method. */
type ResponseShape = Record<string, unknown> & { readonly id: unknown }

const isResponseShaped = (value: unknown): value is ResponseShape =>
  isRecord(value) &&
  'id' in value &&
  !('method' in value) &&
  ('result' in value || 'error' in value)

/**
 * Speaks JSON-RPC over a line writer. It keeps the ids of the requests the
 * server sent and settles them from the lines the peer writes back, so a
 * handler can ask the editor a question and keep running.
 */
export const makeAcpConnection = (input: {
  readonly registry: AcpHandlerRegistry
  readonly write: (line: string) => void
}): AcpConnection => {
  const pending = new Map<
    number,
    { readonly gate: Deferred.Deferred<unknown, AcpRequestFailed>; readonly method: string }
  >()
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
      pending.set(id, { gate, method })
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
   * Matches one response line to the request that asked it. A response nobody
   * waits on is still a response: answering it would put a second answer on the
   * wire, so it is consumed silently. Anything else — a notification, a
   * request, a malformed line — is left to the dispatcher.
   */
  const settle = (parsed: unknown): boolean => {
    if (!isResponseShaped(parsed)) return false
    if (typeof parsed.id !== 'number') return true
    const entry = pending.get(parsed.id)
    if (entry === undefined) return true
    pending.delete(parsed.id)
    if ('error' in parsed) {
      const error = parsed.error
      // A peer that answers with something else answered nothing this server
      // can read; the waiter times out rather than pretending it was refused.
      if (
        isRecord(error) &&
        typeof error['code'] === 'number' &&
        typeof error['message'] === 'string'
      ) {
        Deferred.doneUnsafe(
          entry.gate,
          Effect.fail(
            new AcpRequestFailed({
              method: entry.method,
              code: error['code'],
              message: error['message'],
            }),
          ),
        )
      }
      return true
    }
    Deferred.doneUnsafe(entry.gate, Effect.succeed(parsed.result))
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
    registry: input.registry,
    notify,
    request,
    dispatch,
    pending: () => pending.size,
  }
}
