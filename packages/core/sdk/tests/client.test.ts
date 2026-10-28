import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import {
  HARNESS_METHODS,
  HARNESS_NOTIFICATIONS,
  HarnessClient,
  HarnessResponseError,
  type HarnessChild,
  type HarnessClientOptions,
} from '../src/index.ts'
import type { RequestPermissionParams } from '@jozo-harness/acp'

interface FakeHarness {
  readonly client: HarnessClient
  readonly requests: Array<Record<string, unknown>>
  readonly responses: Array<Record<string, unknown>>
  readonly killed: () => boolean
  readonly exit: () => void
}

interface FakeOptions {
  readonly answerPermission?: HarnessClientOptions['answerPermission']
  readonly onUpdate?: HarnessClientOptions['onUpdate']
}

/**
 * A fake child whose stdout answers from the request it reads on stdin. The
 * responder returns the raw lines to send back, so a test can interleave
 * notifications, server requests, and unknown ids.
 */
const makeHarness = (
  respond: (request: { id: number; method: string }) => string,
  options: FakeOptions = {},
): FakeHarness => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const requests: Array<Record<string, unknown>> = []
  const responses: Array<Record<string, unknown>> = []
  let killed = false
  let leave = (): void => undefined
  const exited = new Promise<void>((resolve) => {
    leave = resolve
  })
  const child: HarnessChild = {
    stdin,
    stdout,
    exited,
    kill: () => {
      killed = true
    },
  }
  const client = new HarnessClient({
    spawn: () => child,
    ...(options.answerPermission === undefined
      ? {}
      : { answerPermission: options.answerPermission }),
    ...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
  })
  const accept = (line: string): void => {
    const parsed = JSON.parse(line) as Record<string, unknown>
    const method = parsed['method']
    const id = parsed['id']
    if (typeof method === 'string' && typeof id === 'number') {
      requests.push(parsed)
      const answer = respond({ id, method })
      if (answer !== '') stdout.write(answer + '\n')
      return
    }
    responses.push(parsed)
  }
  let buffer = ''
  stdin.on('data', (chunk) => {
    buffer += String(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      accept(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  })
  return { client, requests, responses, killed: () => killed, exit: () => leave() }
}

const answer = (request: { id: number }, result: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id: request.id, result })

const update = (sessionId: string, body: unknown): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: HARNESS_NOTIFICATIONS.update,
    params: { sessionId, update: body },
  })

const permissionRequest = (id: number): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: HARNESS_NOTIFICATIONS.requestPermission,
    params: {
      sessionId: 's-1',
      toolCall: { toolCallId: 'c-1', title: 'run a command', kind: 'bash' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Refuse', kind: 'reject_once' },
      ],
    },
  })

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
      {
        jsonrpc: '2.0',
        id: 1,
        method: HARNESS_METHODS.initialize,
        params: { protocolVersion: 1 },
      },
    ])
  })

  test('sends a prompt as a one-element prompt list', async () => {
    const harness = makeHarness((request) => {
      if (request.method === HARNESS_METHODS.newSession)
        return answer(request, { sessionId: 's-1' })
      return answer(request, { stopReason: 'end-turn' })
    })

    const session = await harness.client.newSession('/tmp')
    await harness.client.prompt(session.sessionId, 'hello')

    expect(harness.requests[1]).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: HARNESS_METHODS.prompt,
      params: { sessionId: 's-1', prompt: ['hello'] },
    })
  })

  test('collects the turn text and tool results from the updates before the answer', async () => {
    const harness = makeHarness((request) =>
      [
        update('s-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hel' },
        }),
        update('s-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'c-1',
          title: 'bash echo',
          kind: 'bash',
          status: 'pending',
          rawInput: { command: 'echo hello' },
        }),
        update('s-1', {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c-1',
          status: 'completed',
          content: [{ type: 'text', text: 'hello' }],
        }),
        update('s-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'lo' },
        }),
        answer(request, { stopReason: 'end-turn' }),
      ].join('\n'),
    )

    await expect(harness.client.prompt('s-1', 'run it')).resolves.toEqual({
      stopReason: 'end-turn',
      text: 'Hello',
      toolCalls: [
        {
          toolCallId: 'c-1',
          name: 'bash',
          input: { command: 'echo hello' },
          status: 'completed',
          failed: false,
          output: 'hello',
        },
      ],
    })
  })

  test('observes updates and ignores a result for a call it never saw start', async () => {
    const seen: Array<string> = []
    const harness = makeHarness(
      (request) =>
        [
          update('s-1', {
            sessionUpdate: 'tool_call',
            toolCallId: 'c-1',
            title: 'bash echo',
            kind: 'bash',
            status: 'pending',
          }),
          update('s-1', {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'missing',
            status: 'completed',
            content: [{ type: 'text', text: 'ignored' }],
          }),
          answer(request, { stopReason: 'end-turn' }),
        ].join('\n'),
      { onUpdate: (event) => seen.push(event.update.sessionUpdate) },
    )

    const turn = await harness.client.prompt('s-1', 'run it')

    expect(seen).toEqual(['tool_call', 'tool_call_update'])
    expect(turn.toolCalls).toEqual([
      {
        toolCallId: 'c-1',
        name: 'bash',
        input: undefined,
        status: 'pending',
        failed: false,
      },
    ])
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

  test('rejects a result the protocol does not name', async () => {
    const harness = makeHarness((request) => answer(request, { protocolVersion: 'one' }))

    await expect(harness.client.initialize()).rejects.toThrow('Unexpected result from the peer')
  })

  test('ignores notifications and responses for unknown ids', async () => {
    const harness = makeHarness((request) =>
      [
        JSON.stringify({ jsonrpc: '2.0', method: 'session/unknown', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', id: 99, result: { protocolVersion: 9 } }),
        answer(request, { protocolVersion: 1, agentName: 'jzh' }),
      ].join('\n'),
    )

    await expect(harness.client.initialize()).resolves.toEqual({
      protocolVersion: 1,
      agentName: 'jzh',
    })
  })

  test('answers a permission request with the handler result', async () => {
    const asks: Array<RequestPermissionParams> = []
    const harness = makeHarness(
      (request) =>
        [permissionRequest(900), answer(request, { protocolVersion: 1, agentName: 'jzh' })].join(
          '\n',
        ),
      {
        answerPermission: (request) => {
          asks.push(request)
          return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
        },
      },
    )

    await harness.client.initialize()
    await Promise.resolve()

    expect(asks).toHaveLength(1)
    expect(asks[0]?.toolCall).toMatchObject({ toolCallId: 'c-1', kind: 'bash' })
    expect(harness.responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 900,
        result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      },
    ])
  })

  test('refuses a permission request when no handler is installed', async () => {
    const harness = makeHarness((request) =>
      [permissionRequest(900), answer(request, { protocolVersion: 1, agentName: 'jzh' })].join(
        '\n',
      ),
    )

    await harness.client.initialize()
    await Promise.resolve()

    expect(harness.responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 900,
      result: { outcome: { outcome: 'cancelled' } },
    })
  })

  test('answers an unknown request method with method not found', async () => {
    const harness = makeHarness((request) =>
      [
        JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'session/unknown', params: {} }),
        answer(request, { protocolVersion: 1, agentName: 'jzh' }),
      ].join('\n'),
    )

    await harness.client.initialize()

    expect(harness.responses[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 901,
      error: { code: -32601 },
    })
  })

  test('sends a cancel request and decodes its answer', async () => {
    const harness = makeHarness((request) => answer(request, { cancelled: true }))

    await expect(harness.client.cancel('s-1')).resolves.toEqual({ cancelled: true })
    expect(harness.requests[0]).toMatchObject({
      method: HARNESS_METHODS.cancel,
      params: { sessionId: 's-1' },
    })
  })

  test('close ends the child, rejects a pending request, and waits for the exit', async () => {
    const harness = makeHarness(() => '')
    let left = false
    void harness.client.initialize().catch(() => undefined)

    const closing = harness.client.close().then(() => {
      left = true
    })

    expect(harness.killed()).toBe(true)
    expect(left).toBe(false)
    harness.exit()
    await closing
    expect(left).toBe(true)
  })

  test('close rejects a pending request and a later one', async () => {
    const harness = makeHarness(() => '')
    const pending = harness.client.initialize()
    const closing = harness.client.close()
    harness.exit()

    await expect(pending).rejects.toThrow('HarnessClient is closed')
    await closing
    await expect(harness.client.cancel('s-1')).rejects.toThrow('HarnessClient is closed')
  })

  test('rejects pending requests when the child exits on its own', async () => {
    const harness = makeHarness(() => '')
    const pending = harness.client.initialize()
    harness.exit()

    await expect(pending).rejects.toThrow('Harness process exited')
  })
})
