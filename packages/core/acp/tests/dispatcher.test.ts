import { describe, expect, test } from 'vitest'
import { Schema } from 'effect'
import {
  JSON_RPC_ERROR,
  JsonRpcFault,
  dispatchJsonRpc,
  makeAcpHandlerRegistry,
  type AcpHandlerRegistry,
} from '../src/index.ts'

const registryWith = (handle: (params: unknown) => unknown): AcpHandlerRegistry => {
  const registry = makeAcpHandlerRegistry()
  registry.register('session/new', {
    params: Schema.Struct({ cwd: Schema.String }),
    handle,
  })
  return registry
}

const parse = (line: string | null): unknown => (line === null ? null : JSON.parse(line))

describe('dispatchJsonRpc', () => {
  test('answers a request with the id and the handler result', async () => {
    const registry = registryWith((params) => ({
      sessionId: `session-${(params as { cwd: string }).cwd.length}`,
    }))

    const response = parse(
      await dispatchJsonRpc(
        registry,
        JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/new', params: { cwd: '/tmp' } }),
      ),
    )

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { sessionId: 'session-4' },
    })
  })

  test('answers -32700 when the line is not JSON', async () => {
    const response = parse(await dispatchJsonRpc(makeAcpHandlerRegistry(), '{'))

    expect(response).toMatchObject({ id: null, error: { code: JSON_RPC_ERROR.parse } })
  })

  test('answers -32601 when no handler is registered for the method', async () => {
    const response = parse(
      await dispatchJsonRpc(
        makeAcpHandlerRegistry(),
        JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'session/unknown' }),
      ),
    )

    expect(response).toMatchObject({ id: 'a', error: { code: JSON_RPC_ERROR.methodNotFound } })
  })

  test('answers -32602 when the params do not match the registration', async () => {
    const response = parse(
      await dispatchJsonRpc(
        registryWith(() => ({ sessionId: 'unused' })),
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }),
      ),
    )

    expect(response).toMatchObject({ id: 1, error: { code: JSON_RPC_ERROR.invalidParams } })
  })

  test('answers -32603 when the handler throws', async () => {
    const response = parse(
      await dispatchJsonRpc(
        registryWith(() => {
          throw new Error('boom')
        }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } }),
      ),
    )

    expect(response).toMatchObject({ id: 2, error: { code: JSON_RPC_ERROR.internal } })
  })

  test('answers the code a handler raises itself', async () => {
    const registry = makeAcpHandlerRegistry()
    registry.register('session/cancel', {
      params: Schema.Struct({ sessionId: Schema.String }),
      handle: (params) => {
        const { sessionId } = params as { sessionId: string }
        throw new JsonRpcFault(JSON_RPC_ERROR.invalidParams, 'Unknown session: ' + sessionId)
      },
    })

    const response = parse(
      await dispatchJsonRpc(
        registry,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/cancel',
          params: { sessionId: 'gone' },
        }),
      ),
    )

    expect(response).toMatchObject({
      id: 3,
      error: { code: JSON_RPC_ERROR.invalidParams, message: 'Unknown session: gone' },
    })
  })

  test('runs a notification handler but sends no response', async () => {
    const seen: unknown[] = []
    const registry = registryWith((params) => {
      seen.push(params)
      return { sessionId: 'unused' }
    })

    const response = await dispatchJsonRpc(
      registry,
      JSON.stringify({ jsonrpc: '2.0', method: 'session/new', params: { cwd: '/tmp' } }),
    )

    expect(response).toBeNull()
    expect(seen).toEqual([{ cwd: '/tmp' }])
  })

  test('drops an unknown notification instead of answering it', async () => {
    const response = await dispatchJsonRpc(
      makeAcpHandlerRegistry(),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/unknown' }),
    )

    expect(response).toBeNull()
  })

  test('keeps the server alive while an answer is still being produced', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const registry = makeAcpHandlerRegistry()
    registry.register('session/prompt', {
      params: Schema.Struct({ sessionId: Schema.String, prompt: Schema.Array(Schema.String) }),
      handle: async () => {
        await held
        return { stopReason: 'end-turn' }
      },
    })

    const answered = dispatchJsonRpc(
      registry,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/prompt',
        params: { sessionId: 's-1', prompt: ['hi'] },
      }),
    )
    release()

    expect(JSON.parse((await answered) ?? 'null')).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { stopReason: 'end-turn' },
    })
  })
})
