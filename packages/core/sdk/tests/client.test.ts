import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { HarnessClient, HarnessResponseError, type HarnessChild } from '../src/index.ts'

interface FakeHarness {
  readonly client: HarnessClient
  readonly requests: unknown[]
  readonly killed: () => boolean
}

/**
 * A fake child whose stdout answers from the request it reads on stdin. The
 * responder returns the raw lines to send back, so a test can interleave
 * notifications and unknown ids.
 */
const makeHarness = (respond: (request: { id: number; method: string }) => string): FakeHarness => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const requests: unknown[] = []
  let killed = false
  const child: HarnessChild = {
    stdin,
    stdout,
    kill: () => {
      killed = true
    },
  }
  const client = new HarnessClient({ spawn: () => child })
  let buffer = ''
  stdin.on('data', (chunk) => {
    buffer += String(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string }
      requests.push(request)
      buffer = buffer.slice(newline + 1)
      stdout.write(respond(request) + '\n')
      newline = buffer.indexOf('\n')
    }
  })
  return { client, requests, killed: () => killed }
}

const answer = (request: { id: number }, result: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id: request.id, result })

describe('HarnessClient', () => {
  test('returns the result of a matching response', async () => {
    const harness = makeHarness((request) =>
      answer(request, { protocolVersion: 1, agentName: 'jzh' }),
    )

    await expect(harness.client.initialize()).resolves.toEqual({
      protocolVersion: 1,
      agentName: 'jzh',
    })
    expect(harness.requests).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
    ])
  })

  test('sends a prompt as a one-element prompt list', async () => {
    const harness = makeHarness((request) => {
      if (request.method === 'session/new') return answer(request, { sessionId: 's-1' })
      return answer(request, { stopReason: 'end-turn' })
    })

    const session = await harness.client.newSession('/tmp')
    await harness.client.prompt(session.sessionId, 'hello')

    expect(harness.requests[1]).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's-1', prompt: ['hello'] },
    })
  })

  test('rejects with an Error that keeps the error code and message', async () => {
    const harness = makeHarness((request) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' },
      }),
    )

    const error = await harness.client.initialize().catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(HarnessResponseError)
    expect(error).toMatchObject({ message: 'Method not found', code: -32601 })
  })

  test('ignores notifications and responses for unknown ids', async () => {
    const harness = makeHarness((request) =>
      [
        JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text: 'working' } }),
        JSON.stringify({ jsonrpc: '2.0', id: 99, result: { protocolVersion: 9 } }),
        answer(request, { protocolVersion: 1, agentName: 'jzh' }),
      ].join('\n'),
    )

    await expect(harness.client.initialize()).resolves.toEqual({
      protocolVersion: 1,
      agentName: 'jzh',
    })
  })

  test('close ends the child and rejects a pending request', async () => {
    const harness = makeHarness(() => '')

    const pending = harness.client.initialize()
    harness.client.close()

    expect(harness.killed()).toBe(true)
    await expect(pending).rejects.toThrow('HarnessClient is closed')
  })
})
