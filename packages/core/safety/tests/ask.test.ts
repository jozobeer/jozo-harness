import { decodeSessionEvent } from '@jozo-harness/session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@jozo-harness/session'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { Ask, askEventSchemas, askServiceLayer, installAsk, makeAsk } from '../src/index.ts'

describe('ask', () => {
  test('a served answerer answers the question', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = yield* Ask
        yield* ask.serve(() => Effect.succeed('blue'))
        const answer = yield* ask.ask({ id: 'q1', question: 'which?', options: [] })
        return { served: ask.served(), answer }
      }).pipe(Effect.provide(askServiceLayer)),
    )

    expect(observed).toEqual({ served: true, answer: 'blue' })
  })

  test('a question with nobody listening fails at once', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = yield* Ask
        const served = ask.served()
        const error = yield* Effect.flip(ask.ask({ id: 'q2', question: 'which?', options: [] }))
        return { served, tag: error._tag, message: error.message }
      }).pipe(Effect.provide(askServiceLayer)),
    )

    expect(observed.served).toBe(false)
    expect(observed.tag).toBe('AskUnavailable')
    expect(observed.message).toContain('nobody is listening')
  })

  test('a stopped answerer is nobody listening again', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = yield* makeAsk()
        yield* ask.serve(() => Effect.succeed('blue'))
        yield* ask.stopServing()
        const served = ask.served()
        return {
          served,
          tag: (yield* Effect.flip(ask.ask({ id: 'q3', question: 'which?', options: [] })))._tag,
        }
      }),
    )

    expect(observed).toEqual({ served: false, tag: 'AskUnavailable' })
  })

  test('both events decode from the log', async () => {
    expect([...askEventSchemas.keys()]).toEqual([
      'interaction/ask/requested',
      'interaction/ask/answered',
    ])
    const event = await Effect.runPromise(
      decodeSessionEvent({
        seq: 2,
        time: 1,
        type: 'interaction/ask/requested',
        data: { id: 'q1', question: 'which colour?', options: ['blue', 'red'] },
      }),
    )

    expect(event?.type).toBe('interaction/ask/requested')
  })
})

describe('installAsk', () => {
  test('records the question and the answer', async () => {
    const events: Array<SessionEvent> = []
    const session = {
      id: 's1' as SessionId,
      header: { formatVersion: 1, createdAt: 0, cwd: '/tmp' } as SessionHeader,
      events: () => [...events],
      append: (type: string, data: unknown) =>
        Effect.sync(() => {
          events.push({ seq: events.length + 1, time: 0, type, data } as SessionEvent)
        }),
      flush: () => Effect.void,
      derive: () => [],
    } as unknown as Session

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = installAsk(yield* makeAsk(), session)
        yield* ask.serve(() => Effect.succeed('a'))
        const answer = yield* ask.ask({ id: 'q9', question: 'pick', options: ['a'] })
        return { answer, types: events.map((event) => event.type) }
      }),
    )

    expect(observed.answer).toBe('a')
    expect(observed.types).toEqual(['interaction/ask/requested', 'interaction/ask/answered'])
  })
})
