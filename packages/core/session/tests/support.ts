import { Effect } from 'effect'
import {
  SessionError,
  type OpenedSession,
  type SessionEvent,
  type SessionEventMap,
  type SessionHeader,
  type SessionId,
  type SessionPersistence,
  type SessionSink,
  type SessionSummary,
} from '../src/index.ts'

export const header = (cwd = '/work'): SessionHeader => ({ formatVersion: 1, createdAt: 100, cwd })

export const headerEvent = (cwd = '/work'): SessionEvent => ({
  seq: 1,
  time: 100,
  type: 'session/header',
  data: header(cwd),
})

export const event = <K extends keyof SessionEventMap>(
  seq: number,
  type: K,
  data: SessionEventMap[K],
): SessionEvent => ({ seq, time: 100 + seq, type, data }) as SessionEvent

export interface FakePersistence extends SessionPersistence {
  readonly stored: Map<SessionId, { events: Array<SessionEvent>; summary: SessionSummary }>
}

export const makeFakePersistence = (): FakePersistence => {
  const stored = new Map<SessionId, { events: Array<SessionEvent>; summary: SessionSummary }>()

  const opened = (id: SessionId): OpenedSession => {
    const record = stored.get(id)
    if (record === undefined) throw new Error(`unknown session ${id}`)
    const sink: SessionSink = {
      append: (sessionEvent) =>
        Effect.sync(() => {
          record.events.push(sessionEvent)
          record.summary = { ...record.summary, updatedAt: sessionEvent.time }
        }),
      flush: () => Effect.void,
    }
    return { id, events: [...record.events], sink }
  }

  return {
    stored,
    create: (sessionHeader) =>
      Effect.sync(() => {
        const id = crypto.randomUUID()
        const first: SessionEvent = {
          seq: 1,
          time: sessionHeader.createdAt,
          type: 'session/header',
          data: sessionHeader,
        }
        stored.set(id, {
          events: [first],
          summary: {
            id,
            cwd: sessionHeader.cwd,
            createdAt: sessionHeader.createdAt,
            updatedAt: sessionHeader.createdAt,
            title: '',
          },
        })
        return opened(id)
      }),
    open: (id) =>
      stored.has(id)
        ? Effect.sync(() => opened(id))
        : Effect.fail(new SessionError({ code: 'not-found', message: `no session ${id}` })),
    stat: (id) => {
      const record = stored.get(id)
      return record === undefined
        ? Effect.fail(new SessionError({ code: 'not-found', message: `no session ${id}` }))
        : Effect.succeed(record.summary)
    },
    list: () => Effect.sync(() => [...stored.values()].map((record) => record.summary)),
  }
}
