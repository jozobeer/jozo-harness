import { HooksLive } from '@jozo-harness/kernel'
import { Tools, toolsLayer } from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { mcpTools, startMcpServer } from '../src/index.ts'

const server = [
  'bash',
  '-lc',
  'while IFS= read -r line; do id=$(printf "%s" "$line" | sed -n \'s/.*"id":\\([0-9]*\\).*/\\1/p\'); case "$line" in *"tools/list"*) printf \'{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echoes text"}]}}\\n\' "$id" ;; *) printf \'{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"from mcp"}]}}\\n\' "$id" ;; esac; done',
]

describe('mcpTools', () => {
  test('a server tool becomes a local tool that round-trips', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startMcpServer({ command: server })
          const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
          const tools = Context.get(context, Tools)
          for (const tool of yield* mcpTools(client)) yield* tools.register(tool)
          const names = tools.schemas().map((schema) => schema.name)
          const result = yield* tools.call({
            callId: 'c1',
            tool: 'mcp__echo',
            arguments: JSON.stringify({ text: 'hi' }),
            context: { sessionId: 's1', cwd: '/tmp', callId: 'c1' },
          })
          yield* client.close()
          return { names, isError: result.isError, content: result.content }
        }),
      ),
    )

    expect(observed.names).toEqual(['mcp__echo'])
    expect(observed.isError).toBe(false)
    expect(observed.content).toEqual([{ type: 'text', text: 'from mcp' }])
  })

  test('a server tool declares a timeout so a stuck server cannot hold the turn', async () => {
    const declared = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startMcpServer({ command: server })
          const tools = yield* mcpTools(client)
          yield* client.close()
          return tools.map((tool) => tool.timeoutMs)
        }),
      ),
    )

    expect(declared.length).toBeGreaterThan(0)
    for (const ms of declared) {
      expect(ms).toBeGreaterThan(0)
      expect(ms).toBeLessThanOrEqual(60_000)
    }
  })
})
