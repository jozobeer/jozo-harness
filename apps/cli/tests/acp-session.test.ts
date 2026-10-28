import { Effect, Fiber, Queue, Stream } from 'effect'
import { describe, expect, test } from 'vitest'
import type { UiEvent, UiHost } from '@jozo-harness/ui-host'
import { AcpTimeout, type AcpClient } from '@jozo-harness/acp'
import { acpSessionPortOf, approvedOf, type AcpSessionSource } from '../src/acp.ts'

interface FakeHost {
  readonly host: UiHost
  readonly offer: (event: UiEvent) => void
  readonly submitted: Array<string>
  readonly approvals: Array<{ readonly callId: string; readonly approved: boolean }>
  readonly cancels: () => number
}

const makeHost = (id: string): FakeHost => {
  const queue = Effect.runSync(Queue.unbounded<UiEvent>())
  const submitted: Array<string> = []
  const approvals: Array<{ readonly callId: string; readonly approved: boolean }> = []
  let cancelled = 0
  const host: UiHost = {
    events: Stream.fromQueue(queue),
    submit: (text) =>
      Effect.sync(() => {
        submitted.push(text)
      }),
    approve: (callId, approved) =>
      Effect.sync(() => {
        approvals.push({ callId, approved })
      }),
    answer: () => Effect.void,
    cancel: () =>
      Effect.sync(() => {
        cancelled += 1
      }),
    setEffort: () => Effect.void,
    setModel: () => Effect.void,
    answerApproval: () => Effect.succeed(false),
    answerAsk: () => Effect.succeed(''),
  }
  return {
    host,
    offer: (event) => Queue.offerUnsafe(queue, event),
    submitted,
    approvals,
    cancels: () => cancelled,
  }
}

const sourceOf = (host: UiHost, id = 's-1'): AcpSessionSource => ({
  open: () => Effect.succeed({ id, host }),
})

interface Calls {
  readonly requests: Array<{ readonly method: string; readonly params: unknown }>
  readonly notifications: Array<{ readonly method: string; readonly params: unknown }>
}

const clientOf = (
  answer: (method: string, params: unknown) => Effect.Effect<unknown, AcpTimeout>,
): { readonly client: AcpClient; readonly calls: Calls } => {
  const calls: Calls = { requests: [], notifications: [] }
  return {
    calls,
    client: {
      request: (method, params) => {
        calls.requests.push({ method, params })
        return answer(method, params)
      },
      notify: (method, params) => {
        calls.notifications.push({ method, params })
        return Effect.void
      },
    },
  }
}

const sessionEvent = (type: string, data: unknown, seq = 1): UiEvent => ({
  kind: 'session',
  event: { seq, time: 0, type, data },
})

const sleep = (ms: number): Effect.Effect<void> =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

const scoped = <A, E>(effect: Effect.Effect<A, E, import('effect').Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect))

describe('acpSessionPortOf', () => {
  test('streams the assistant text of the prompted turn and ends with end-turn', async () => {
    const fake = makeHost('s-1')
    const { client, calls } = clientOf(() =>
      Effect.fail(new AcpTimeout({ method: 'x', timeoutMs: 1 })),
    )
    const port = acpSessionPortOf(sourceOf(fake.host))

    const result = await scoped(
      Effect.gen(function* () {
        const session = yield* port.open('/work', client)
        const answered = yield* Effect.forkScoped(session.prompt('hello'))
        yield* sleep(5)
        fake.offer(sessionEvent('turn/start', { turn: 1 }))
        fake.offer(
          sessionEvent('assistant/message', {
            provider: 'p',
            model: 'm',
            content: [
              { type: 'text', text: 'hi ' },
              { type: 'tool-call', id: 'c-1', name: 'bash', arguments: '{}' },
              { type: 'text', text: 'there' },
            ],
            stream: [],
          }),
        )
        fake.offer(sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
        return yield* Fiber.join(answered)
      }),
    )

    expect(result).toEqual({ stopReason: 'end-turn' })
    expect(fake.submitted).toEqual(['hello'])
    expect(calls.notifications).toEqual([
      {
        method: 'session/update',
        params: {
          sessionId: 's-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hi there' },
          },
        },
      },
    ])
    expect(calls.requests).toEqual([])
  })

  test('asks the editor for permission and allows the call when it answers allow-once', async () => {
    const fake = makeHost('s-1')
    const { client, calls } = clientOf(() =>
      Effect.succeed({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
    )
    const port = acpSessionPortOf(sourceOf(fake.host))

    await scoped(
      Effect.gen(function* () {
        const session = yield* port.open('/work', client)
        fake.offer(
          sessionEvent('safety/approval/requested', {
            callId: 'c-1',
            tool: 'bash',
            reason: 'run ls',
          }),
        )
        yield* sleep(20)
        expect(session.id).toBe('s-1')
      }),
    )

    expect(calls.requests[0]).toMatchObject({
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { toolCallId: 'c-1', title: 'run ls', kind: 'bash' },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      },
    })
    expect(fake.approvals).toEqual([{ callId: 'c-1', approved: true }])
  })

  test('refuses the call when the editor never answers', async () => {
    const fake = makeHost('s-1')
    const { client } = clientOf(() =>
      Effect.fail(new AcpTimeout({ method: 'session/request_permission', timeoutMs: 5 })),
    )
    const port = acpSessionPortOf(sourceOf(fake.host), { permissionTimeoutMs: 5 })

    await scoped(
      Effect.gen(function* () {
        yield* port.open('/work', client)
        fake.offer(
          sessionEvent('safety/approval/requested', { callId: 'c-1', tool: 'bash', reason: '' }),
        )
        yield* sleep(30)
      }),
    )

    expect(fake.approvals).toEqual([{ callId: 'c-1', approved: false }])
  })

  test('refuses the call when the editor answers with a rejection', async () => {
    const fake = makeHost('s-1')
    const { client } = clientOf(() =>
      Effect.succeed({ outcome: { outcome: 'selected', optionId: 'reject-once' } }),
    )
    const port = acpSessionPortOf(sourceOf(fake.host))

    await scoped(
      Effect.gen(function* () {
        yield* port.open('/work', client)
        fake.offer(
          sessionEvent('safety/approval/requested', { callId: 'c-2', tool: 'write', reason: '' }),
        )
        yield* sleep(20)
      }),
    )

    expect(fake.approvals).toEqual([{ callId: 'c-2', approved: false }])
  })

  test('cancels the running turn and answers the prompt as cancelled', async () => {
    const fake = makeHost('s-1')
    const { client } = clientOf(() => Effect.fail(new AcpTimeout({ method: 'x', timeoutMs: 1 })))
    const port = acpSessionPortOf(sourceOf(fake.host))

    const result = await scoped(
      Effect.gen(function* () {
        const session = yield* port.open('/work', client)
        const answered = yield* Effect.forkScoped(session.prompt('slow'))
        yield* sleep(5)
        fake.offer(sessionEvent('turn/start', { turn: 1 }))
        yield* session.cancel()
        fake.offer(
          sessionEvent('turn/end', { turn: 1, reason: { kind: 'cancelled', cause: 'user' } }),
        )
        return yield* Fiber.join(answered)
      }),
    )

    expect(result).toEqual({ stopReason: 'cancelled' })
    expect(fake.cancels()).toBe(1)
  })

  test('ignores the end of a turn that ran before this prompt', async () => {
    const fake = makeHost('s-1')
    const { client } = clientOf(() => Effect.fail(new AcpTimeout({ method: 'x', timeoutMs: 1 })))
    const port = acpSessionPortOf(sourceOf(fake.host))

    const result = await scoped(
      Effect.gen(function* () {
        const session = yield* port.open('/work', client)
        const answered = yield* Effect.forkScoped(session.prompt('second'))
        yield* sleep(5)
        // This end belongs to the turn that was already running when the prompt arrived.
        fake.offer(sessionEvent('turn/end', { turn: 0, reason: { kind: 'completed' } }))
        fake.offer(sessionEvent('turn/start', { turn: 1 }))
        fake.offer(sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
        return yield* Fiber.join(answered)
      }),
    )

    expect(result).toEqual({ stopReason: 'end-turn' })
  })
})

describe('approvedOf', () => {
  test('reads only the allow-once choice as an approval', () => {
    expect(approvedOf({ outcome: { outcome: 'selected', optionId: 'allow-once' } })).toBe(true)
    expect(approvedOf({ outcome: { outcome: 'selected', optionId: 'reject-once' } })).toBe(false)
    expect(approvedOf({ outcome: { outcome: 'cancelled' } })).toBe(false)
    expect(approvedOf(null)).toBe(false)
    expect(approvedOf({})).toBe(false)
  })
})
