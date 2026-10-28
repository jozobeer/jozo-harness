import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { createServer } from 'node:http'
import { afterEach, describe, expect, test, vi } from 'vitest'
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

/** A forward proxy that answers every call itself, so the test never leaves the loopback. */
const startAnsweringProxy = async (
  body: string,
): Promise<{ origin: string; stop: () => Promise<void> }> => {
  const server = createServer((_incoming, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(body)
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  return {
    origin: 'http://127.0.0.1:' + String(port),
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

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

  test('goes through HTTP_PROXY when the environment names one', async () => {
    const proxy = await startAnsweringProxy('hello through the proxy')
    vi.stubEnv('HTTP_PROXY', proxy.origin)
    vi.stubEnv('NO_PROXY', '')
    vi.stubEnv('no_proxy', '')

    const result = await Effect.runPromise(call(webFetchTool, { url: 'http://upstream.example/' }))

    expect(result?.value).toEqual({
      url: 'http://upstream.example/',
      status: 200,
      text: 'hello through the proxy',
      truncated: false,
    })
    await proxy.stop()
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
