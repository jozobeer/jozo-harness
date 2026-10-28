import { describe, expect, test } from 'vitest'
import { Schema } from 'effect'
import {
  JSON_RPC_ERROR,
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
  test('answers a request with the id and the handler result', () => {
    const registry = registryWith((params) => ({
      sessionId: `session-${(params as { cwd: string }).cwd.length}`,
    }))

    const response = parse(
      dispatchJsonRpc(
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

  test('answers -32700 when the line is not JSON', () => {
    const response = parse(dispatchJsonRpc(makeAcpHandlerRegistry(), '{'))

    expect(response).toMatchObject({ id: null, error: { code: JSON_RPC_ERROR.parse } })
  })

  test('answers -32601 when no handler is registered for the method', () => {
    const response = parse(
      dispatchJsonRpc(
        makeAcpHandlerRegistry(),
        JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'session/unknown' }),
      ),
    )

    expect(response).toMatchObject({ id: 'a', error: { code: JSON_RPC_ERROR.methodNotFound } })
  })

  test('answers -32602 when the params do not match the registration', () => {
    const response = parse(
      dispatchJsonRpc(
        registryWith(() => ({ sessionId: 'unused' })),
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }),
      ),
    )

    expect(response).toMatchObject({ id: 1, error: { code: JSON_RPC_ERROR.invalidParams } })
  })

  test('answers -32603 when the handler throws', () => {
    const response = parse(
      dispatchJsonRpc(
        registryWith(() => {
          throw new Error('boom')
        }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } }),
      ),
    )

    expect(response).toMatchObject({ id: 2, error: { code: JSON_RPC_ERROR.internal } })
  })

  test('runs a notification handler but sends no response', () => {
    const seen: unknown[] = []
    const registry = registryWith((params) => {
      seen.push(params)
      return { sessionId: 'unused' }
    })

    const response = dispatchJsonRpc(
      registry,
      JSON.stringify({ jsonrpc: '2.0', method: 'session/new', params: { cwd: '/tmp' } }),
    )

    expect(response).toBeNull()
    expect(seen).toEqual([{ cwd: '/tmp' }])
  })
})
