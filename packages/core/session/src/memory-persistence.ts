import { Effect } from 'effect'
import { SessionError } from './errors.ts'
import type { SessionEvent, SessionHeader, SessionId } from './events.ts'
import type {
  OpenedSession,
  SessionPersistence,
  SessionSink,
  SessionSummary,
} from './persistence.ts'
import { titleOf } from './title.ts'

export interface MemoryPersistenceOptions {
  /** The id source; a page has no disk name to borrow one from. */
  readonly id?: () => SessionId
}

const notFound = (id: SessionId): SessionError =>
  new SessionError({ code: 'not-found', message: `no session ${id}` })

/**
 * A session log that lives only in this process. It keeps the same shape as the
 * JSONL provider, so a browser runtime can be assembled without a disk while the
 * Node page keeps its durable log.
 */
export function memoryPersistence(options: MemoryPersistenceOptions = {}): SessionPersistence {
  const idOf = options.id ?? (() => crypto.randomUUID())
  const logs = new Map<SessionId, Array<SessionEvent>>()

  const sinkFor = (events: Array<SessionEvent>): SessionSink => ({
    append: (event) => Effect.sync(() => void events.push(event)),
    flush: () => Effect.void,
  })

  const opened = (id: SessionId, events: Array<SessionEvent>): OpenedSession => ({
    id,
    events: [...events],
    sink: sinkFor(events),
  })

  const require = (id: SessionId): Effect.Effect<Array<SessionEvent>, SessionError> =>
    Effect.suspend(() => {
      const events = logs.get(id)
      return events === undefined ? Effect.fail(notFound(id)) : Effect.succeed(events)
    })

  /** The header and the last write a summary reads; absent header fields read as unset. */
  const basicsOf = (events: ReadonlyArray<SessionEvent>) => {
    const first = events[0]
    return {
      header: first?.type === 'session/header' ? first.data : undefined,
      updatedAt: events.at(-1)?.time,
      empty: events.length === 1,
    }
  }

  const summaryOf = (id: SessionId, events: ReadonlyArray<SessionEvent>): SessionSummary => {
    const { header, updatedAt, empty } = basicsOf(events)
    return {
      id,
      cwd: header?.cwd ?? '',
      createdAt: header?.createdAt ?? 0,
      updatedAt: updatedAt ?? header?.createdAt ?? 0,
      title: titleOf(events),
      empty,
    }
  }

  return {
    create: (header: SessionHeader) =>
      Effect.sync(() => {
        const id = idOf()
        const first: SessionEvent = {
          seq: 1,
          time: header.createdAt,
          type: 'session/header',
          data: header,
        }
        const events = [first]
        logs.set(id, events)
        return opened(id, events)
      }),
    open: (id: SessionId) => Effect.map(require(id), (events) => opened(id, events)),
    read: (id: SessionId) => Effect.map(require(id), (events) => [...events]),
    stat: (id: SessionId) => Effect.map(require(id), (events) => summaryOf(id, events)),
    list: () => Effect.sync(() => [...logs.entries()].map(([id, events]) => summaryOf(id, events))),
  }
}
