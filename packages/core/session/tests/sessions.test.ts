import { describe, expect, test } from 'vitest'
import { Hooks, HooksLive } from '@jozo-harness/kernel'
import { Effect } from 'effect'
import { Sessions, sessionsLayer, type SessionEvent } from '../src/index.ts'
import { makeFakePersistence } from './support.ts'

describe('Sessions', () => {
  test('creates a session, appends through it, reopens it, and lists it', async () => {
    const persistence = makeFakePersistence()
    const value = crypto.randomUUID()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const session = yield* sessions.create({ cwd: '/work' })
        yield* session.append('user/message', { text: value, source: 'user' })
        const reopened = yield* sessions.open(session.id)
        return { id: session.id, events: reopened.events(), summaries: yield* sessions.list() }
      }).pipe(
        Effect.provide(sessionsLayer(persistence, { now: () => 1234 })),
        Effect.provide(HooksLive),
      ),
    )

    expect(result.events.map((sessionEvent) => sessionEvent.type)).toEqual([
      'session/header',
      'user/message',
    ])
    expect(result.events[1]?.data).toEqual({ text: value, source: 'user' })
    expect(result.summaries).toEqual([
      { id: result.id, cwd: '/work', createdAt: 1234, updatedAt: 1234, title: '' },
    ])
    expect(persistence.stored.size).toBe(1)
  })

  test('publishes appended events to session/event listeners', async () => {
    const persistence = makeFakePersistence()
    const seen: Array<SessionEvent> = []
    const value = crypto.randomUUID()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hooks = yield* Hooks
          yield* hooks.on('session/event', (sessionEvent) => {
            seen.push(sessionEvent)
          })
          const sessions = yield* Sessions
          const session = yield* sessions.create({ cwd: '/work' })
          yield* session.append('user/message', { text: value, source: 'user' })
        }).pipe(
          Effect.provide(sessionsLayer(persistence, { now: () => 1234 })),
          Effect.provide(HooksLive),
        ),
      ),
    )

    expect(seen.map((sessionEvent) => sessionEvent.type)).toEqual(['user/message'])
  })

  test('open fails with not-found for an unknown id', async () => {
    const persistence = makeFakePersistence()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Sessions
        return yield* Effect.flip(sessions.open('missing'))
      }).pipe(Effect.provide(sessionsLayer(persistence)), Effect.provide(HooksLive)),
    )

    expect(error.code).toBe('not-found')
  })
})
