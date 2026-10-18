import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { startStubServer } from '@jozo-harness/test-support-stub'
import { webFetchTool } from '../src/index.ts'

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'c1',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd: '/tmp', callId: 'c1' },
      })
    }),
  )

describe('web_fetch tool', () => {
  test('reads a body from a local server', async () => {
    const server = await startStubServer(
      () => new Response('hello from the server', { status: 200 }),
    )
    const url = server.origin + '/'

    const result = await Effect.runPromise(call(webFetchTool, { url }))

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual({
      url,
      status: 200,
      text: 'hello from the server',
      truncated: false,
    })
    await server.stop()
  })

  test('honours the byte limit', async () => {
    const server = await startStubServer(() => new Response('abcdefghij', { status: 200 }))
    const url = server.origin + '/'

    const result = await Effect.runPromise(call(webFetchTool, { url, maxBytes: 4 }))

    expect(result?.value).toEqual({ url, status: 200, text: 'abcd', truncated: true })
    await server.stop()
  })

  test('declares a timeout so a server that never answers cannot hold the call', () => {
    expect(webFetchTool.timeoutMs).toBeGreaterThan(0)
    expect(webFetchTool.timeoutMs).toBeLessThanOrEqual(60_000)
  })

  test('refuses a non-http url before calling out', async () => {
    const result = await Effect.runPromise(call(webFetchTool, { url: 'file:///etc/passwd' }))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('not an http(s) url')
  })
})
