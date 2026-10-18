import { Effect, Schema } from 'effect'
import type { ContentBlock } from '@jozo-harness/llm'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { TOOLS_CALL, TOOLS_LIST } from './mcp-codec.ts'
import { NETWORK_TOOL_TIMEOUT_MS } from './timeouts.ts'
import type { McpClientShape } from './mcp.ts'

interface ToolListing {
  readonly tools?: ReadonlyArray<{ readonly name?: string; readonly description?: string }>
}

const textBlocks = (value: unknown): ReadonlyArray<ContentBlock> => {
  if (typeof value !== 'object' || value === null) return []
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const entry = block as { type?: unknown; text?: unknown }
    return entry.type === 'text' && typeof entry.text === 'string'
      ? [{ type: 'text' as const, text: entry.text }]
      : []
  })
}

/** The names a server offers, prefixed so they cannot collide with local tools. */
export const mcpToolNames = async (
  client: McpClientShape,
  prefix: string,
): Promise<ReadonlyArray<string>> => {
  const listed = (await Effect.runPromise(client.request(TOOLS_LIST))) as ToolListing
  return (listed.tools ?? []).flatMap((tool) =>
    typeof tool.name === 'string' ? [prefix + tool.name] : [],
  )
}

/** One tool per server tool: the arguments go through untouched. */
export const mcpTools = (
  client: McpClientShape,
  prefix = 'mcp__',
): Effect.Effect<ReadonlyArray<ToolDefinition<any, any>>, ToolError> =>
  Effect.gen(function* () {
    const listed = yield* client.request(TOOLS_LIST)
    const tools = (listed as ToolListing).tools ?? []
    return tools.flatMap((tool) => {
      if (typeof tool.name !== 'string') return []
      const name = tool.name
      const definition: ToolDefinition<unknown, unknown> = {
        name: prefix + name,
        description: tool.description ?? 'An MCP tool',
        parameters: Schema.Unknown,
        // A stuck server answers no JSON-RPC response, so the call needs a bound.
        timeoutMs: NETWORK_TOOL_TIMEOUT_MS,
        output: {
          schema: Schema.Unknown,
          render: (_args, value) => textBlocks(value),
        },
        execute: (args) => client.request(TOOLS_CALL, { name, arguments: args }),
      }
      return [definition]
    })
  })
