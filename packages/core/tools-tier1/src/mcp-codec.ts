/** One JSON-RPC message on an MCP stdio stream, one per line. */
export interface McpRequest {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

export interface McpResponse {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** One request as a line, ready to write to the server's stdin. */
export const encodeRequest = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }) + '\n'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface McpEnvelope {
  readonly id: number
  readonly error: unknown
  readonly result: unknown
}

const asEnvelope = (value: unknown): McpEnvelope | undefined =>
  isRecord(value) && value.jsonrpc === '2.0' && typeof value.id === 'number'
    ? { id: value.id, error: value.error, result: value.result }
    : undefined

const asError = (
  value: unknown,
): { readonly code: number; readonly message: string } | undefined =>
  isRecord(value)
    ? {
        code: Number(value.code ?? 0),
        message: typeof value.message === 'string' ? value.message : '',
      }
    : undefined

/** A response line, or nothing when the line is a notification or is malformed. */
export const decodeResponse = (line: string): McpResponse | undefined => {
  const text = line.trim()
  if (text === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const envelope = asEnvelope(parsed)
  if (envelope === undefined) return undefined
  const error = asError(envelope.error)
  return error === undefined
    ? { jsonrpc: '2.0', id: envelope.id, result: envelope.result }
    : { jsonrpc: '2.0', id: envelope.id, error }
}

/** The MCP handshake and the calls v1 uses. */
export const INITIALIZE = 'initialize'
export const TOOLS_LIST = 'tools/list'
export const TOOLS_CALL = 'tools/call'
export const RESOURCES_LIST = 'resources/list'
export const RESOURCES_READ = 'resources/read'
