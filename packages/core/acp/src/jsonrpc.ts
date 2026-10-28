import { Schema } from 'effect'

/**
 * The id a JSON-RPC 2.0 peer sent. It is absent on notifications, and null when
 * a peer that could not be attributed asked something.
 */
export const JsonRpcIdSchema = Schema.Union([Schema.String, Schema.Number, Schema.Null])

/** The error codes this server answers with, as named by JSON-RPC 2.0. */
export const JSON_RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export const JsonRpcErrorSchema = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
})

/** A call: it carries an id, so the peer waits for a matching response. */
export const JsonRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: JsonRpcIdSchema,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})

/** A one-way message: no id, so the peer must not receive a response. */
export const JsonRpcNotificationSchema = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})

export const JsonRpcSuccessResponseSchema = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: JsonRpcIdSchema,
  result: Schema.Unknown,
})

export const JsonRpcErrorResponseSchema = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: JsonRpcIdSchema,
  error: JsonRpcErrorSchema,
})

/** Either half of an answer; the presence of `result` vs `error` tells them apart. */
export const JsonRpcResponseSchema = Schema.Union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
])

export type JsonRpcId = Schema.Schema.Type<typeof JsonRpcIdSchema>
export type JsonRpcError = Schema.Schema.Type<typeof JsonRpcErrorSchema>
export type JsonRpcRequest = Schema.Schema.Type<typeof JsonRpcRequestSchema>
export type JsonRpcNotification = Schema.Schema.Type<typeof JsonRpcNotificationSchema>
export type JsonRpcResponse = Schema.Schema.Type<typeof JsonRpcResponseSchema>
