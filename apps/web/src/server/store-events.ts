import { Effect, Queue, Stream } from 'effect'

/**
 * What one web server tells every page about the store itself: a session was
 * opened, closed, or had its row changed by another device. A page reads the
 * store with its own call; this only says the copy it read is now old.
 */
export interface StoreEvents {
  /** One signal per change from now on; a page that joins late has missed the earlier ones. */
  readonly subscribe: () => Stream.Stream<number>
  /** Announces a change to every page that already follows the store. */
  readonly notify: () => void
}

/**
 * One server's store changes, fanned out to every connected page. The session
 * log already reaches every subscriber of that session; without this the list
 * of sessions stayed as old as the page that loaded it, so a device could not
 * see the session another device had just opened.
 */
export const makeStoreEvents = (): StoreEvents => {
  const subscribers = new Set<Queue.Queue<number>>()
  let sequence = 0
  return {
    subscribe: () =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<number>()
            subscribers.add(queue)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                subscribers.delete(queue)
              }),
            )
            return Stream.fromQueue(queue)
          }),
        ),
      ),
    notify: () => {
      sequence += 1
      for (const queue of subscribers.values().toArray()) Queue.offerUnsafe(queue, sequence)
    },
  }
}
