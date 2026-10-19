import { describe, expect, test } from 'vitest'
import { Deferred, Effect, Exit, Logger, Scope } from 'effect'
import type { Bail, Emit, Parallel, Serial, Waterfall } from '../src/index.ts'
import { Hooks, HooksLive, makeHooks } from '../src/index.ts'

/** Collects Effect log output so an expected defect is asserted instead of printed. */
const recordLogs = () => {
  const messages: Array<string> = []
  const logger = Logger.make(({ message }) => {
    messages.push(String(message))
  })
  return { messages, layer: Logger.layer([logger]) }
}

declare module '../src/hook.ts' {
  interface HookMap {
    'test/emit': Emit<(value: string) => void>
    'test/serial': Serial<(value: string) => Effect.Effect<void, Error>>
    'test/parallel': Parallel<() => Effect.Effect<void>>
    'test/bail': Bail<(value: string) => Effect.Effect<string | undefined>>
    'test/waterfall': Waterfall<(value: number) => Effect.Effect<number>>
  }
}

describe('hook registration', () => {
  test('a listener is registered until its scope closes', async () => {
    const hooks = makeHooks()
    const seen: string[] = []
    const value = crypto.randomUUID()
    const scope = Effect.runSync(Scope.make())

    await Effect.runPromise(
      hooks
        .on('test/emit', (v) => {
          seen.push(v)
        })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    )
    await Effect.runPromise(hooks.emit('test/emit', value))
    expect(seen).toEqual([value])

    await Effect.runPromise(Scope.close(scope, Exit.void))
    await Effect.runPromise(hooks.emit('test/emit', value))
    expect(seen).toEqual([value])
  })

  test('prepend puts the listener before the existing ones', async () => {
    const hooks = makeHooks()
    const order: string[] = []
    const value = crypto.randomUUID()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('test/emit', () => {
            order.push('first')
          })
          yield* hooks.on(
            'test/emit',
            () => {
              order.push('prepended')
            },
            { prepend: true },
          )
          yield* hooks.emit('test/emit', value)
        }),
      ),
    )

    expect(order).toEqual(['prepended', 'first'])
  })
})

describe('emit', () => {
  test('calls every listener and isolates a throwing listener', async () => {
    const hooks = makeHooks()
    const seen: string[] = []
    const value = crypto.randomUUID()
    const logs = recordLogs()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('test/emit', () => {
            throw new Error('listener defect')
          })
          yield* hooks.on('test/emit', (v) => {
            seen.push(v)
          })
          yield* hooks.emit('test/emit', value)
        }),
      ).pipe(Effect.provide(logs.layer)),
    )

    expect(seen).toEqual([value])
    expect(logs.messages.join('\n')).toContain('hook listener failed')
  })
})

describe('serial', () => {
  test('runs listeners in order and stops at the first failure', async () => {
    const hooks = makeHooks()
    const order: string[] = []
    const value = crypto.randomUUID()
    const failure = new Error('serial failure')

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('test/serial', () =>
            Effect.sync(() => {
              order.push('first')
            }),
          )
          yield* hooks.on('test/serial', () =>
            Effect.sync(() => {
              order.push('second')
            }).pipe(Effect.andThen(Effect.fail(failure))),
          )
          yield* hooks.on('test/serial', () =>
            Effect.sync(() => {
              order.push('third')
            }),
          )
          return yield* hooks.serial('test/serial', value)
        }),
      ).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(order).toEqual(['first', 'second'])
  })
})

describe('parallel', () => {
  test('starts listeners concurrently', async () => {
    const hooks = makeHooks()
    const order: string[] = []
    const gate = Effect.runSync(Deferred.make<void>())

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('test/parallel', () =>
            Effect.sync(() => {
              order.push('waiter')
            }).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(() =>
                Effect.sync(() => {
                  order.push('waiter:done')
                }),
              ),
            ),
          )
          yield* hooks.on('test/parallel', () =>
            Effect.sync(() => {
              order.push('unlock')
            }).pipe(Effect.andThen(Deferred.succeed(gate, void 0))),
          )
          yield* hooks.parallel('test/parallel')
        }),
      ),
    )

    expect(order).toEqual(['waiter', 'unlock', 'waiter:done'])
  })
})

describe('bail', () => {
  test('returns the first answer and skips the rest', async () => {
    const hooks = makeHooks()
    const calls: string[] = []
    const value = crypto.randomUUID()

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('test/bail', () =>
            Effect.sync(() => {
              calls.push('first')
            }).pipe(Effect.as(undefined)),
          )
          yield* hooks.on('test/bail', () =>
            Effect.sync(() => {
              calls.push('second')
            }).pipe(Effect.as(`answer:${value}`)),
          )
          yield* hooks.on('test/bail', () =>
            Effect.sync(() => {
              calls.push('third')
            }).pipe(Effect.as('unreachable')),
          )
          return yield* hooks.bail('test/bail', value)
        }),
      ),
    )

    expect(answer).toBe(`answer:${value}`)
    expect(calls).toEqual(['first', 'second'])
  })
})

describe('waterfall', () => {
  test('delegates through next and short-circuits on a returning listener', async () => {
    const hooks = makeHooks()
    const calls: string[] = []
    const input = Math.floor(Math.random() * 1000) + 1

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('test/waterfall', (_input, next) =>
            Effect.sync(() => {
              calls.push('first')
            }).pipe(
              Effect.andThen(next()),
              Effect.map((n) => n + 1),
            ),
          )
          yield* hooks.on('test/waterfall', (value) =>
            Effect.sync(() => {
              calls.push('second')
              return value * 10
            }),
          )
          yield* hooks.on('test/waterfall', () =>
            Effect.sync(() => {
              calls.push('third')
              return 0
            }),
          )
          return yield* hooks.waterfall('test/waterfall', input)
        }),
      ),
    )

    expect(result).toBe(input * 10 + 1)
    expect(calls).toEqual(['first', 'second'])
  })

  test('returns undefined when no listener answers', async () => {
    const hooks = makeHooks()
    const input = Math.floor(Math.random() * 1000) + 1
    expect(await Effect.runPromise(hooks.waterfall('test/waterfall', input))).toBeUndefined()
  })
})

describe('Hooks service', () => {
  // Two sessions in one process are two builds. A listener one build added must
  // not answer the other's steps: the registry is the application's, not the process's.
  test('gives each build its own registry', async () => {
    const seen: string[] = []
    const registrations = Effect.runSync(Scope.make())

    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const hooks = yield* Hooks
        yield* hooks.on('test/emit', (value: string) => {
          seen.push(value)
        })
        return hooks
      }).pipe(Effect.provide(HooksLive), Effect.provideService(Scope.Scope, registrations)),
    )
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const hooks = yield* Hooks
        yield* hooks.emit('test/emit', 'leaked')
        return hooks
      }).pipe(Effect.provide(HooksLive)),
    )

    expect(second).not.toBe(first)
    expect(seen).toEqual([])

    await Effect.runPromise(Scope.close(registrations, Exit.void))
  })

  test('is usable through the context', async () => {
    const value = crypto.randomUUID()
    const seen: string[] = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hooks = yield* Hooks
          yield* hooks.on('test/emit', (v) => {
            seen.push(v)
          })
          yield* hooks.emit('test/emit', value)
        }).pipe(Effect.provide(HooksLive)),
      ),
    )

    expect(seen).toEqual([value])
  })
})
