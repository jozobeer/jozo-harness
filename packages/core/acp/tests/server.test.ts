import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  AcpTimeout,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  makeAcpConnection,
  makeAcpHandlerRegistry,
  serveAcp,
  type AcpSessionHost,
  type AcpSessionPort,
  type SessionPromptResult,
} from '../src/index.ts'

/** An input an editor writes into, one line at a time, until it closes the pipe. */
const makeInput = () => {
  const queue: Array<string> = []
  let wake: (() => void) | undefined
  let closed = false
  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        while (queue.length > 0) yield queue.shift() ?? ''
      }
    },
  }
  return {
    iterable,
    send: (line: unknown) => {
      queue.push(JSON.stringify(line) + '\n')
      wake?.()
      wake = undefined
    },
    sendRaw: (line: string) => {
      queue.push(line + '\n')
      wake?.()
      wake = undefined
    },
    close: () => {
      closed = true
      wake?.()
      wake = undefined
    },
  }
}

interface Harness {
  readonly output: () => ReadonlyArray<Record<string, unknown>>
  readonly waitFor: (count: number) => Promise<void>
  readonly send: (line: unknown) => void
  readonly sendRaw: (line: string) => void
  readonly close: () => void
}

const start = (sessions: AcpSessionPort): Harness => {
  const input = makeInput()
  const lines: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  const write = (line: string): void => {
    lines.push(JSON.parse(line) as Record<string, unknown>)
    for (const wake of waiters.splice(0)) wake()
  }
  void Effect.runPromise(Effect.scoped(serveAcp({ input: input.iterable, write, sessions }))).catch(
    () => undefined,
  )
  return {
    output: () => lines,
    waitFor: async (count) => {
      while (lines.length < count) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
        })
      }
    },
    send: input.send,
    sendRaw: input.sendRaw,
    close: input.close,
  }
}

const hostOf = (id: string, overrides: Partial<AcpSessionHost> = {}): AcpSessionHost => ({
  id,
  prompt: () => Effect.succeed<SessionPromptResult>({ stopReason: 'end-turn' }),
  cancel: () => Effect.void,
  close: () => Effect.void,
  ...overrides,
})

const portOf = (open: AcpSessionPort['open']): AcpSessionPort => ({ open })

const request = (id: number, method: string, params?: unknown): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
})

describe('serveAcp', () => {
  test('answers initialize, session/new, and session/prompt in order', async () => {
    const session = hostOf('s-1')
    const harness = start(portOf((_cwd) => Effect.succeed(session)))

    harness.send(request(1, 'initialize', { protocolVersion: 1 }))
    await harness.waitFor(1)
    harness.send(request(2, 'session/new', { cwd: '/work' }))
    await harness.waitFor(2)
    harness.send(request(3, 'session/prompt', { sessionId: 's-1', prompt: ['hello'] }))
    await harness.waitFor(3)

    expect(harness.output()).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: 1,
          agentName: 'jozo-harness',
          agentCapabilities: { promptCapabilities: { image: false, audio: false } },
        },
      },
      { jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } },
      { jsonrpc: '2.0', id: 3, result: { stopReason: 'end-turn' } },
    ])
    harness.close()
  })

  test('answers a broken line with -32700 and keeps answering', async () => {
    const harness = start(portOf(() => Effect.succeed(hostOf('s-1'))))

    harness.sendRaw('{')
    harness.send(request(2, 'initialize', { protocolVersion: 1 }))
    await harness.waitFor(2)

    expect(harness.output()[0]).toMatchObject({ id: null, error: { code: -32700 } })
    expect(harness.output()[1]).toMatchObject({ id: 2, result: { protocolVersion: 1 } })
    harness.close()
  })

  test('answers an unknown method and an unknown session without ending the process', async () => {
    const harness = start(portOf(() => Effect.succeed(hostOf('s-1'))))

    harness.send(request(1, 'session/unknown'))
    harness.send(request(2, 'session/prompt', { sessionId: 'gone', prompt: ['x'] }))
    harness.send(request(3, 'initialize', { protocolVersion: 1 }))
    await harness.waitFor(3)

    expect(harness.output()[0]).toMatchObject({ id: 1, error: { code: -32601 } })
    expect(harness.output()[1]).toMatchObject({
      id: 2,
      error: { code: -32602, message: 'Unknown session: gone' },
    })
    expect(harness.output()[2]).toMatchObject({ id: 3, result: { protocolVersion: 1 } })
    harness.close()
  })

  test('reads a cancel notification while a prompt waits, then answers the prompt', async () => {
    let cancel: (() => void) | undefined
    const harness = start(
      portOf((_cwd) =>
        Effect.succeed(
          hostOf('s-1', {
            prompt: () =>
              Effect.promise(
                () =>
                  new Promise<SessionPromptResult>((resolve) => {
                    cancel = () => resolve({ stopReason: 'cancelled' })
                  }),
              ),
            cancel: () =>
              Effect.sync(() => {
                cancel?.()
              }),
          }),
        ),
      ),
    )

    harness.send(request(1, 'session/new', { cwd: '/work' }))
    await harness.waitFor(1)
    harness.send(request(2, 'session/prompt', { sessionId: 's-1', prompt: ['x'] }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    harness.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's-1' } })
    await harness.waitFor(2)

    expect(harness.output()[1]).toMatchObject({ id: 2, result: { stopReason: 'cancelled' } })
    harness.close()
  })

  test('a permission request the editor ignores times out as a refusal', async () => {
    let stopped = ''
    const harness = start(
      portOf((_cwd, client) =>
        Effect.succeed(
          hostOf('s-1', {
            prompt: () =>
              client
                .request(
                  'session/request_permission',
                  {
                    sessionId: 's-1',
                    toolCall: { toolCallId: 'c-1', title: 'run a command', kind: 'bash' },
                    options: [],
                  },
                  { timeoutMs: 20 },
                )
                .pipe(
                  Effect.as<SessionPromptResult>({ stopReason: 'end-turn' }),
                  Effect.catchTag('AcpTimeout', () =>
                    Effect.sync(() => {
                      stopped = 'refused'
                      return { stopReason: 'refused' as const }
                    }),
                  ),
                ),
          }),
        ),
      ),
    )

    harness.send(request(1, 'session/new', { cwd: '/work' }))
    await harness.waitFor(1)
    harness.send(request(2, 'session/prompt', { sessionId: 's-1', prompt: ['use bash'] }))
    await harness.waitFor(3)

    expect(harness.output()[1]).toMatchObject({
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { toolCallId: 'c-1', title: 'run a command', kind: 'bash' },
      },
    })
    expect(harness.output()[2]).toMatchObject({ id: 2, result: { stopReason: 'refused' } })
    expect(stopped).toBe('refused')
    expect(DEFAULT_PERMISSION_TIMEOUT_MS).toBeGreaterThan(20)
    harness.close()
  })
})

describe('makeAcpConnection', () => {
  test('settles a server request when the editor answers it', async () => {
    const registry = makeAcpHandlerRegistry()
    const lines: Array<Record<string, unknown>> = []
    const connection = makeAcpConnection({
      registry,
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    })

    const answered = Effect.runPromise(
      connection.request('session/request_permission', { sessionId: 's-1' }, { timeoutMs: 1000 }),
    )
    await Promise.resolve()
    expect(lines[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/request_permission',
    })

    await Effect.runPromise(
      connection.dispatch(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
        }),
      ),
    )

    await expect(answered).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })
    expect(connection.pending()).toBe(0)
  })

  test('fails the request when the editor answers with an error', async () => {
    const registry = makeAcpHandlerRegistry()
    const connection = makeAcpConnection({ registry, write: () => undefined })

    const answered = Effect.runPromise(
      connection.request('session/request_permission', {}, { timeoutMs: 1000 }),
    )
    await Promise.resolve()
    await Effect.runPromise(
      connection.dispatch(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'no such request' },
        }),
      ),
    )

    await expect(answered).rejects.toMatchObject({ code: -32601, message: 'no such request' })
  })

  test('a response for an unknown id is not a request answer', async () => {
    const registry = makeAcpHandlerRegistry()
    const connection = makeAcpConnection({ registry, write: () => undefined })

    await expect(
      Effect.runPromise(
        connection.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} })),
      ),
    ).resolves.toBeNull()
    expect(connection.pending()).toBe(0)
  })

  test('times out a request the editor never answers', async () => {
    const registry = makeAcpHandlerRegistry()
    const connection = makeAcpConnection({ registry, write: () => undefined })

    const error = await Effect.runPromise(
      connection
        .request('session/request_permission', {}, { timeoutMs: 5 })
        .pipe(Effect.catchTag('AcpTimeout', (cause) => Effect.succeed(cause))),
    )

    expect(error).toBeInstanceOf(AcpTimeout)
    expect(connection.pending()).toBe(0)
  })
})
