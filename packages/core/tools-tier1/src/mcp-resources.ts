import { Effect } from 'effect'
import { ToolError } from '@jozo-harness/tools'
import { RESOURCES_LIST, RESOURCES_READ } from './mcp-codec.ts'
import type { McpClientShape } from './mcp.ts'

/** One resource a server lists, reduced to the fields a reader chooses by. */
export interface McpResource {
  readonly uri: string
  readonly name?: string
  readonly mimeType?: string
}

/** One text resource body. Binary bodies stay out of this layer for now. */
export interface McpTextResource {
  readonly uri: string
  readonly mimeType?: string
  readonly text: string
}

/** A listed content entry this layer cannot hand back as text. */
export interface McpUnsupportedResource {
  readonly uri: string
  readonly reason: 'blob'
}

export interface McpResourceRead {
  readonly contents: ReadonlyArray<McpTextResource>
  readonly unsupported: ReadonlyArray<McpUnsupportedResource>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

/**
 * Whether an initialize result declares resources. Servers that omit the
 * capability reject resources/list, so the check belongs before the request.
 */
export const supportsMcpResources = (initialize: unknown): boolean =>
  isRecord(initialize) &&
  isRecord(initialize.capabilities) &&
  isRecord(initialize.capabilities.resources)

const requireResources = (initialize: unknown): Effect.Effect<void, ToolError> =>
  supportsMcpResources(initialize)
    ? Effect.void
    : Effect.fail(
        new ToolError({
          code: 'unavailable',
          message: 'MCP server does not declare the resources capability',
        }),
      )

const toResource = (value: unknown): McpResource | undefined => {
  if (!isRecord(value)) return undefined
  const uri = optionalString(value.uri)
  if (uri === undefined) return undefined
  const name = optionalString(value.name)
  const mimeType = optionalString(value.mimeType)
  return {
    uri,
    ...(name === undefined ? {} : { name }),
    ...(mimeType === undefined ? {} : { mimeType }),
  }
}

const readEntries = (value: unknown): ReadonlyArray<unknown> =>
  isRecord(value) && Array.isArray(value.contents) ? value.contents : []

const toTextResource = (
  entry: Readonly<Record<string, unknown>>,
  uri: string,
): McpTextResource | undefined => {
  if (typeof entry.text !== 'string') return undefined
  const mimeType = optionalString(entry.mimeType)
  return { uri, ...(mimeType === undefined ? {} : { mimeType }), text: entry.text }
}

const toRead = (value: unknown, requestedUri: string): McpResourceRead => {
  const contents: Array<McpTextResource> = []
  const unsupported: Array<McpUnsupportedResource> = []
  for (const entry of readEntries(value)) {
    if (!isRecord(entry)) continue
    const uri = optionalString(entry.uri) ?? requestedUri
    const text = toTextResource(entry, uri)
    if (text !== undefined) contents.push(text)
    else if (typeof entry.blob === 'string') unsupported.push({ uri, reason: 'blob' })
  }
  return { contents, unsupported }
}

/**
 * Lists the resources a server declared in its initialize result. The caller
 * owns the handshake and passes its result so this layer stays a thin adapter.
 */
export const listMcpResources = (
  client: McpClientShape,
  initialize: unknown,
): Effect.Effect<ReadonlyArray<McpResource>, ToolError> =>
  Effect.gen(function* () {
    yield* requireResources(initialize)
    const listed = yield* client.request(RESOURCES_LIST)
    const entries = isRecord(listed) && Array.isArray(listed.resources) ? listed.resources : []
    return entries.flatMap((entry) => {
      const resource = toResource(entry)
      return resource === undefined ? [] : [resource]
    })
  })

/** Reads one resource by URI, keeping text bodies and naming binary ones. */
export const readMcpResource = (
  client: McpClientShape,
  initialize: unknown,
  uri: string,
): Effect.Effect<McpResourceRead, ToolError> =>
  Effect.gen(function* () {
    yield* requireResources(initialize)
    const read = yield* client.request(RESOURCES_READ, { uri })
    return toRead(read, uri)
  })
