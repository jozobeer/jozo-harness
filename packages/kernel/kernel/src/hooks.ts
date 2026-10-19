import { Context, Effect, Layer, type Scope } from 'effect'
import type { HookRegistry, OnOptions } from './hook.ts'

type AnyListener = (...args: ReadonlyArray<unknown>) => unknown

interface ListenerEntry {
  readonly listener: AnyListener
}

/** Creates an empty hook registry. Listeners live until the scope that added them closes. */
export function makeHooks(): HookRegistry {
  const registry = new Map<string, ReadonlyArray<ListenerEntry>>()

  const listenersOf = (name: string): ReadonlyArray<ListenerEntry> => registry.get(name) ?? []

  const on = (
    name: string,
    listener: AnyListener,
    options?: OnOptions,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const entry: ListenerEntry = { listener }
      const current = listenersOf(name)
      registry.set(name, options?.prepend === true ? [entry, ...current] : [...current, entry])
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          const remaining = listenersOf(name).filter((candidate) => candidate !== entry)
          if (remaining.length === 0) registry.delete(name)
          else registry.set(name, remaining)
        }),
      )
    })

  const effectOf = (
    entry: ListenerEntry,
    args: ReadonlyArray<unknown>,
  ): Effect.Effect<unknown, unknown, unknown> =>
    entry.listener(...args) as Effect.Effect<unknown, unknown, unknown>

  const emit = (name: string, ...args: ReadonlyArray<unknown>): Effect.Effect<void> =>
    Effect.forEach(
      listenersOf(name),
      (entry) =>
        Effect.sync(() => entry.listener(...args)).pipe(
          Effect.catchDefect((defect) =>
            Effect.logError('hook listener failed', { hook: name, defect }),
          ),
        ),
      { discard: true },
    )

  const serial = (
    name: string,
    ...args: ReadonlyArray<unknown>
  ): Effect.Effect<unknown, unknown, unknown> =>
    Effect.forEach(listenersOf(name), (entry) => effectOf(entry, args), { discard: true })

  const parallel = (
    name: string,
    ...args: ReadonlyArray<unknown>
  ): Effect.Effect<unknown, unknown, unknown> =>
    Effect.forEach(listenersOf(name), (entry) => effectOf(entry, args), {
      concurrency: 'unbounded',
      discard: true,
    })

  const bail = (
    name: string,
    ...args: ReadonlyArray<unknown>
  ): Effect.Effect<unknown, unknown, unknown> =>
    Effect.gen(function* () {
      for (const entry of listenersOf(name)) {
        const answer = yield* effectOf(entry, args)
        if (answer !== undefined) return answer
      }
      return undefined
    })

  const waterfall = (
    name: string,
    ...args: ReadonlyArray<unknown>
  ): Effect.Effect<unknown, unknown, unknown> => {
    const entries = listenersOf(name)
    const run = (index: number): Effect.Effect<unknown, unknown, unknown> => {
      const entry = entries[index]
      if (entry === undefined) return Effect.succeed(undefined)
      return effectOf(entry, [...args, () => run(index + 1)])
    }
    return run(0)
  }

  return { on, emit, serial, parallel, bail, waterfall } as unknown as HookRegistry
}

/** Kernel service that owns the application-scoped hook registry. */
export class Hooks extends Context.Service<Hooks, HookRegistry>()('jozo-harness/Hooks') {}

// Each build is its own application: sessions served by one process open and close
// separately, so one build's listeners must not answer another's steps.
export const HooksLive: Layer.Layer<Hooks> = Layer.effect(
  Hooks,
  Effect.sync(() => makeHooks()),
)
