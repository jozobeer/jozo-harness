import { decodeSessionEvent } from '@jozo-harness/session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@jozo-harness/session'
import { Deferred, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, test } from 'vitest'
import {
  Ask,
  askEventSchemas,
  askServiceLayer,
  installAsk,
  makeAsk,
  type AskAnswer,
  type AskBatchAnswered,
} from '../src/index.ts'

const request = (callId = 'c1') => ({
  callId,
  questions: [
    {
      id: 'colour',
      question: 'which colour?',
      options: [{ label: 'blue' }, { label: 'red' }],
      multiSelect: false,
    },
    {
      id: 'toppings',
      question: 'which toppings?',
      options: [{ label: 'cheese' }, { label: 'olives' }],
      multiSelect: true,
    },
  ],
})

const answers: ReadonlyArray<AskAnswer> = [
  { id: 'colour', selected: ['blue'] },
  { id: 'toppings', selected: ['cheese', 'olives'], custom: 'no anchovies' },
]

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

  test('a batch answerer answers every question in one call', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = yield* makeAsk()
        yield* ask.serveBatch(() => Effect.succeed(answers))
        return yield* ask.askBatch(request())
      }),
    )

    expect(observed).toEqual({ _tag: 'answered', answers })
  })

  test('a batch with nobody listening fails at once', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = yield* makeAsk()
        const error = yield* Effect.flip(ask.askBatch(request()))
        return { tag: error._tag, message: error.message }
      }),
    )

    expect(observed.tag).toBe('AskUnavailable')
    expect(observed.message).toContain('nobody is listening')
  })

  test('a time limit returns the unanswered questions as pending', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = yield* makeAsk({ timeLimitMs: 1000 })
        const gate = yield* Deferred.make<ReadonlyArray<AskAnswer>>()
        yield* ask.serveBatch(() => Deferred.await(gate))
        const fiber = yield* Effect.forkChild(ask.askBatch(request()))
        yield* TestClock.adjust('1 second')
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observed).toEqual({
      _tag: 'pending',
      callId: 'c1',
      unanswered: ['colour', 'toppings'],
    })
  })

  test('an answer after the limit reaches the late-answer handler with its call id', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = yield* makeAsk({ timeLimitMs: 1000 })
        const gate = yield* Deferred.make<ReadonlyArray<AskAnswer>>()
        const late = yield* Deferred.make<AskBatchAnswered>()
        yield* ask.serveBatch(() => Deferred.await(gate))
        ask.onLateAnswer((answered) => Deferred.succeed(late, answered).pipe(Effect.asVoid))
        const fiber = yield* Effect.forkChild(ask.askBatch(request()))
        yield* TestClock.adjust('1 second')
        const pending = yield* Fiber.join(fiber)
        yield* Deferred.succeed(gate, answers)
        return { pending, answered: yield* Deferred.await(late) }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observed.pending._tag).toBe('pending')
    expect(observed.answered).toEqual({ callId: 'c1', answers })
  })

  test('every event this module adds decodes from the log', async () => {
    expect([...askEventSchemas.keys()]).toEqual([
      'interaction/ask/requested',
      'interaction/ask/answered',
      'interaction/ask/questions',
      'interaction/ask/answers',
      'interaction/ask/pending',
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
  const recordingSession = (events: Array<SessionEvent>): Session =>
    ({
      id: 's1' as SessionId,
      header: { formatVersion: 1, createdAt: 0, cwd: '/tmp' } as SessionHeader,
      events: () => [...events],
      append: (type: string, data: unknown) =>
        Effect.sync(() => {
          events.push({ seq: events.length + 1, time: 0, type, data } as SessionEvent)
        }),
      flush: () => Effect.void,
      derive: () => [],
    }) as unknown as Session

  test('records the question and the answer', async () => {
    const events: Array<SessionEvent> = []
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = installAsk(yield* makeAsk(), recordingSession(events))
        yield* ask.serve(() => Effect.succeed('a'))
        const answer = yield* ask.ask({ id: 'q9', question: 'pick', options: ['a'] })
        return { answer, types: events.map((event) => event.type) }
      }),
    )

    expect(observed.answer).toBe('a')
    expect(observed.types).toEqual(['interaction/ask/requested', 'interaction/ask/answered'])
  })

  test('keeps the call id on a batch that expired and on the answer that arrived later', async () => {
    const events: Array<SessionEvent> = []
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const ask = installAsk(yield* makeAsk({ timeLimitMs: 1000 }), recordingSession(events))
        const gate = yield* Deferred.make<ReadonlyArray<AskAnswer>>()
        const late = yield* Deferred.make<AskBatchAnswered>()
        yield* ask.serveBatch(() => Deferred.await(gate))
        ask.onLateAnswer((answered) => Deferred.succeed(late, answered).pipe(Effect.asVoid))
        const fiber = yield* Effect.forkChild(ask.askBatch(request('call-9')))
        yield* TestClock.adjust('1 second')
        const pending = yield* Fiber.join(fiber)
        yield* Deferred.succeed(gate, answers)
        return {
          pending,
          types: events.map((event) => event.type),
          late: yield* Deferred.await(late),
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observed.pending._tag).toBe('pending')
    expect(observed.types).toEqual([
      'interaction/ask/questions',
      'interaction/ask/pending',
      'interaction/ask/answers',
    ])
    expect(eventsById(events, 'interaction/ask/answers')).toEqual({
      callId: 'call-9',
      answers,
    })
    expect(observed.late.callId).toBe('call-9')
  })
})

const eventsById = (events: ReadonlyArray<SessionEvent>, type: string): unknown =>
  events.find((event) => event.type === type)?.data
