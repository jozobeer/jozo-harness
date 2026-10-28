import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  deriveMessages,
  FEEDBACK_MEMO_LIMIT,
  feedbackOf,
  makeSession,
  rateFeedback,
  type SessionEvent,
} from '../src/index.ts'

const header = {
  seq: 1,
  time: 0,
  type: 'session/header',
  data: { formatVersion: 1, createdAt: 0, cwd: '/work' },
} as const

const answer = (seq: number) =>
  ({
    seq,
    time: seq,
    type: 'assistant/message',
    data: {
      provider: 'stub',
      model: 'stub',
      content: [{ type: 'text', text: 'the answer' }],
      stream: [],
    },
  }) as const

const build = (events: ReadonlyArray<SessionEvent> = [header, answer(2)]) =>
  Effect.runPromise(
    makeSession({
      id: 's-1',
      events,
      sink: { append: () => Effect.void, flush: () => Effect.void },
      now: () => 10,
    }),
  )

describe('rating an answer', () => {
  test('keeps the latest verdict and memo for the same answer', async () => {
    const session = await build()

    await Effect.runPromise(rateFeedback(session, { rating: 'like', target: 2, memo: 'clear' }))
    await Effect.runPromise(
      rateFeedback(session, { rating: 'dislike', target: 2, memo: 'wrong turn' }),
    )

    expect([...feedbackOf(session.events()).values()]).toEqual([
      { target: 2, rating: 'dislike', memo: 'wrong turn' },
    ])
  })

  test('rates the newest answer when no target is named', async () => {
    const session = await build([header, answer(2), answer(3)])

    const rated = await Effect.runPromise(rateFeedback(session, { rating: 'like' }))

    expect(rated.target).toBe(3)
  })

  test('refuses a memo longer than the limit and logs nothing', async () => {
    const session = await build()

    const outcome = await Effect.runPromise(
      rateFeedback(session, {
        rating: 'like',
        target: 2,
        memo: 'x'.repeat(FEEDBACK_MEMO_LIMIT + 1),
      }).pipe(Effect.flip),
    )

    expect(outcome.code).toBe('memo-too-long')
    expect(session.events().some((event) => event.type === 'feedback/rated')).toBe(false)
  })

  test('refuses a target that is not an answer', async () => {
    const session = await build()

    const outcome = await Effect.runPromise(
      rateFeedback(session, { rating: 'like', target: 1 }).pipe(Effect.flip),
    )

    expect(outcome.code).toBe('bad-target')
  })

  test('never reaches the next request the model reads', async () => {
    const session = await build()
    const before = deriveMessages(session.events())

    await Effect.runPromise(
      rateFeedback(session, { rating: 'dislike', target: 2, memo: 'not wanted here' }),
    )

    expect(deriveMessages(session.events())).toEqual(before)
    expect(JSON.stringify(deriveMessages(session.events()))).not.toContain('not wanted here')
  })
})
