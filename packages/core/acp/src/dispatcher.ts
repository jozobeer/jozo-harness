import { Schema } from 'effect'
import {
  JSON_RPC_ERROR,
  JsonRpcFault,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  type JsonRpcId,
} from './jsonrpc.ts'
import type { AcpHandlerRegistration, AcpHandlerRegistry } from './methods.ts'

/**
 * One line in, one line out. null means the peer sent a notification, and a
 * notification never gets an answer — not even for an unknown method.
 */
export type DispatchResult = string | null

/** What a handler call produced, before it becomes a response line. */
type Outcome =
  | { readonly kind: 'result'; readonly result: unknown }
  | { readonly kind: 'method-not-found' }
  | { readonly kind: 'invalid-params' }
  | { readonly kind: 'internal' }
  | { readonly kind: 'fault'; readonly fault: JsonRpcFault }

const respond = (id: JsonRpcId, result: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result })

const fail = (id: JsonRpcId, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })

const hasId = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'id' in value

const decodeParams = (
  registration: AcpHandlerRegistration,
  params: unknown,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  if (registration.params === undefined) return { ok: true, value: params }
  try {
    return { ok: true, value: Schema.decodeUnknownSync(registration.params)(params) }
  } catch {
    return { ok: false }
  }
}

/**
 * Runs one registered handler. A handler may take a turn's worth of time, so the
 * answer is awaited; a fault it throws is the answer it chose.
 */
const run = async (
  registry: AcpHandlerRegistry,
  method: string,
  params: unknown,
): Promise<Outcome> => {
  const registration = registry.get(method)
  if (registration === undefined) return { kind: 'method-not-found' }
  const decoded = decodeParams(registration, params)
  if (!decoded.ok) return { kind: 'invalid-params' }
  try {
    return { kind: 'result', result: await registration.handle(decoded.value) }
  } catch (cause) {
    return cause instanceof JsonRpcFault ? { kind: 'fault', fault: cause } : { kind: 'internal' }
  }
}

/**
 * Routes a JSON-RPC line to an injected handler. It owns no transport and no
 * sessions: the caller reads the line and writes the answer.
 */
export const dispatchJsonRpc = async (
  registry: AcpHandlerRegistry,
  line: string,
): Promise<DispatchResult> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return fail(null, JSON_RPC_ERROR.parse, 'Parse error')
  }

  if (!hasId(parsed)) {
    // A notification has no reply channel, so its outcome is dropped.
    if (Schema.is(JsonRpcNotificationSchema)(parsed)) {
      await run(registry, parsed.method, parsed.params)
    }
    return null
  }

  if (!Schema.is(JsonRpcRequestSchema)(parsed)) {
    return fail(null, JSON_RPC_ERROR.invalidRequest, 'Invalid request')
  }

  const outcome = await run(registry, parsed.method, parsed.params)
  switch (outcome.kind) {
    case 'result':
      return respond(parsed.id, outcome.result)
    case 'method-not-found':
      return fail(parsed.id, JSON_RPC_ERROR.methodNotFound, 'Method not found')
    case 'invalid-params':
      return fail(parsed.id, JSON_RPC_ERROR.invalidParams, 'Invalid params')
    case 'fault':
      return fail(parsed.id, outcome.fault.code, outcome.fault.message)
    case 'internal':
      return fail(parsed.id, JSON_RPC_ERROR.internal, 'Internal error')
  }
}
