import { describe, expect, test } from 'vitest'
import type { Agent } from '@jozo-harness/agent'
import { makeHooks } from '@jozo-harness/kernel'
import { LlmFailure } from '@jozo-harness/llm'
import { Effect } from 'effect'
import { installRetry } from '../src/index.ts'

const agent = {} as Agent

/** Installs the policy, dispatches inside the same scope, then lets it unload. */
const dispatch = <A>(
  config: Parameters<typeof installRetry>[1],
  run: (hooks: ReturnType<typeof makeHooks>) => Effect.Effect<A>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hooks = makeHooks()
        yield* installRetry(hooks, config)
        return yield* run(hooks)
      }),
    ),
  )

describe('installRetry', () => {
  test('answers a transient failure with a bounded wait', async () => {
    const decisions = await dispatch(
      { maxRetries: 1, initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      (hooks) =>
        Effect.gen(function* () {
          const first = yield* hooks.waterfall(
            'agent/request-error',
            agent,
            new LlmFailure({ code: 'RATE_LIMIT', message: 'slow down' }),
            1,
          )
          const second = yield* hooks.waterfall(
            'agent/request-error',
            agent,
            new LlmFailure({ code: 'RATE_LIMIT', message: 'again' }),
            2,
          )
          return [first, second]
        }),
    )

    expect(decisions).toEqual([{ kind: 'retry', delayMs: 10 }, undefined])
  })

  test('leaves an unlisted failure to the next listener', async () => {
    const decision = await dispatch({ retryableCodes: ['TIMEOUT'] }, (hooks) =>
      hooks.waterfall(
        'agent/request-error',
        agent,
        new LlmFailure({ code: 'AUTH', message: 'bad key' }),
        1,
      ),
    )
    // The waterfall has no other listener, so an unclaimed failure reads as undefined.
    expect(decision).toBeUndefined()
  })
})
