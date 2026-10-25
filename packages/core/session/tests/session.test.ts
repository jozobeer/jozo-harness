import { describe, expect, test } from 'vitest'
import { Effect, Fiber, Logger } from 'effect'
import { SessionError, makeSession, type SessionEvent, type SessionSink } from '../src/index.ts'
import { event, headerEvent } from './support.ts'

/** Collects Effect log output so an expected defect is asserted instead of printed. */
const recordLogs = () => {
  const messages: Array<string> = []
  const logger = Logger.make(({ message }) => {
    messages.push(String(message))
  })
  return { messages, layer: Logger.layer([logger]) }
}

interface Collected {
  readonly written: Array<SessionEvent>
  readonly notified: Array<SessionEvent>
  readonly flushes: Array<number>
  readonly sink: SessionSink
}

const collect = (): Collected => {
  const written: Array<SessionEvent> = []
  const notified: Array<SessionEvent> = []
  const flushes: Array<number> = []
  return {
    written,
    notified,
    flushes,
    sink: {
      append: (sessionEvent) =>
        Effect.sync(() => {
          written.push(sessionEvent)
        }),
      flush: () =>
        Effect.sync(() => {
          flushes.push(1)
        }),
    },
  }
}

describe('makeSession', () => {
  test('appends with the next seq and the injected time, then notifies observers', async () => {
    const collected = collect()
    const value = crypto.randomUUID()
    const session = await Effect.runPromise(
      makeSession({
        id: 's-1',
        events: [headerEvent()],
        sink: collected.sink,
        now: () => 111,
        notify: (sessionEvent) =>
          Effect.sync(() => {
            collected.notified.push(sessionEvent)
          }),
      }),
    )

    await Effect.runPromise(session.append('user/message', { text: value, source: 'user' }))

    expect(collected.written).toHaveLength(1)
    expect(collected.written[0]?.seq).toBe(2)
    expect(collected.written[0]?.time).toBe(111)
    expect(collected.written[0]?.type).toBe('user/message')
    expect(collected.notified).toEqual(collected.written)
    expect(session.events().map((sessionEvent) => sessionEvent.type)).toEqual([
      'session/header',
      'user/message',
    ])
    expect(session.header.cwd).toBe('/work')
  })

  test('continues the seq of a resumed log', async () => {
    const collected = collect()
    const session = await Effect.runPromise(
      makeSession({
        id: 's-2',
        events: [headerEvent(), event(2, 'user/message', { text: 'earlier', source: 'user' })],
        sink: collected.sink,
        now: () => 222,
      }),
    )

    await Effect.runPromise(session.append('system/message', { text: 'resume' }))

    expect(collected.written[0]?.seq).toBe(3)
  })

  test('rejects non-JSON data without writing or notifying', async () => {
    const collected = collect()
    const session = await Effect.runPromise(
      makeSession({ id: 's-3', events: [headerEvent()], sink: collected.sink, now: () => 1 }),
    )

    const error = await Effect.runPromise(
      Effect.flip(
        session.append('user/message', { text: Number.NaN as unknown as string, source: 'user' }),
      ),
    )

    expect(error).toBeInstanceOf(SessionError)
    expect(error.code).toBe('not-serializable')
    expect(collected.written).toEqual([])
  })

  test('an observer failure does not fail the append', async () => {
    const collected = collect()
    const logs = recordLogs()
    const session = await Effect.runPromise(
      makeSession({
        id: 's-4',
        events: [headerEvent()],
        sink: collected.sink,
        now: () => 1,
        notify: () => Effect.fail(new Error('observer exploded')),
      }),
    )

    await Effect.runPromise(
      session
        .append('user/message', { text: 'still stored', source: 'user' })
        .pipe(Effect.provide(logs.layer)),
    )

    expect(collected.written).toHaveLength(1)
    expect(logs.messages.join('\n')).toContain('session/event observer failed')
  })

  test('flush delegates to the sink', async () => {
    const collected = collect()
    const session = await Effect.runPromise(
      makeSession({ id: 's-5', events: [headerEvent()], sink: collected.sink, now: () => 1 }),
    )

    await Effect.runPromise(session.flush())

    expect(collected.flushes).toHaveLength(1)
  })

  test('refuses a log that does not start with session/header', async () => {
    const collected = collect()
    const error = await Effect.runPromise(
      Effect.flip(makeSession({ id: 's-6', events: [], sink: collected.sink })),
    )

    expect(error.code).toBe('persistence')
  })

  test('continues past the highest stored seq when the restored log has a gap', async () => {
    const collected = collect()
    const session = await Effect.runPromise(
      makeSession({
        id: 's-gap',
        events: [headerEvent(), event(4, 'user/message', { text: 'kept', source: 'user' })],
        sink: collected.sink,
        now: () => 9,
      }),
    )

    await Effect.runPromise(session.append('system/message', { text: 'next' }))

    // A count would reuse seq 3, and the page drops any event that is not newer
    // than the last one it applied, so the appended line would never appear.
    expect(collected.written[0]?.seq).toBe(5)
    expect(session.events().map((sessionEvent) => sessionEvent.seq)).toEqual([1, 4, 5])
  })

  test('overlapping appends take successive seqs', async () => {
    const collected = collect()
    let calls = 0
    let releaseFirst: () => void = () => undefined
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markEntered: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const session = await Effect.runPromise(
      makeSession({
        id: 's-overlap',
        events: [headerEvent()],
        now: () => 7,
        sink: {
          append: (sessionEvent) =>
            Effect.gen(function* () {
              calls += 1
              if (calls === 1) {
                markEntered()
                yield* Effect.promise(() => holdFirst)
              }
              collected.written.push(sessionEvent)
            }),
          flush: () => Effect.void,
        },
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(
          session.append('user/message', { text: 'one', source: 'user' }),
        )
        yield* Effect.promise(() => entered)
        const second = yield* Effect.forkChild(session.append('system/message', { text: 'two' }))
        // The first append is held inside the sink. Yield so the second fiber
        // reaches the log while that write is still open.
        yield* Effect.yieldNow
        yield* Effect.sleep('1 millis')
        releaseFirst()
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    )

    expect(collected.written.map((sessionEvent) => sessionEvent.seq)).toEqual([2, 3])
    expect(session.events().map((sessionEvent) => sessionEvent.seq)).toEqual([1, 2, 3])
  })

  test('a failed append does not keep the next one from writing', async () => {
    const collected = collect()
    let calls = 0
    const session = await Effect.runPromise(
      makeSession({
        id: 's-retry',
        events: [headerEvent()],
        sink: {
          append: (sessionEvent) =>
            Effect.gen(function* () {
              calls += 1
              if (calls === 1) {
                return yield* Effect.fail(
                  new SessionError({ code: 'persistence', message: 'disk full' }),
                )
              }
              collected.written.push(sessionEvent)
            }),
          flush: () => Effect.void,
        },
        now: () => 1,
      }),
    )

    const error = await Effect.runPromise(
      Effect.flip(session.append('user/message', { text: 'lost', source: 'user' })),
    )
    await Effect.runPromise(session.append('system/message', { text: 'kept' }))

    expect(error.code).toBe('persistence')
    expect(collected.written.map((sessionEvent) => sessionEvent.seq)).toEqual([2])
    expect(session.events().map((sessionEvent) => sessionEvent.type)).toEqual([
      'session/header',
      'system/message',
    ])
  })
})
