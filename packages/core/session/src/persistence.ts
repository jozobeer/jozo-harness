import type { Effect } from 'effect'
import type { SessionError } from './errors.ts'
import type { SessionEvent, SessionHeader, SessionId } from './events.ts'

/** Where one live session writes. The provider owns durability and flush timing. */
export interface SessionSink {
  readonly append: (event: SessionEvent) => Effect.Effect<void, SessionError>
  readonly flush: () => Effect.Effect<void, SessionError>
}

/** A session restored by a persistence provider, ready to append. */
export interface OpenedSession {
  readonly id: SessionId
  readonly events: ReadonlyArray<SessionEvent>
  readonly sink: SessionSink
}

export interface SessionSummary {
  readonly id: SessionId
  readonly cwd: string
  readonly createdAt: number
  /** When the log was last written, in ms; a fresh session reads as its creation. */
  readonly updatedAt: number
  /** The first thing the human typed, one short line; '' when the log holds none. */
  readonly title: string
}

/** The persistence seam. S1 provides a JSONL implementation in `@jozo-harness/session-jsonl`. */
export interface SessionPersistence {
  readonly create: (header: SessionHeader) => Effect.Effect<OpenedSession, SessionError>
  readonly open: (id: SessionId) => Effect.Effect<OpenedSession, SessionError>
  readonly stat: (id: SessionId) => Effect.Effect<SessionSummary, SessionError>
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, SessionError>
}
