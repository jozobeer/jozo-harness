import type { Effect } from 'effect'
import type { DerivedMessage } from './derive.ts'
import type { SessionError } from './errors.ts'
import type { SessionEvent, SessionHeader, SessionId, SessionSeq } from './events.ts'
import type { ProjectionCheckpoint } from './projection-checkpoint.ts'

/** Where one live session writes. The provider owns durability and flush timing. */
export interface SessionSink {
  readonly append: (event: SessionEvent) => Effect.Effect<void, SessionError>
  readonly flush: () => Effect.Effect<void, SessionError>
  /**
   * The projection saved with the log, so a reopened session folds only what came
   * after it. A provider that cannot keep one omits both hooks and every open
   * folds the whole log.
   */
  readonly loadProjection?: () => Effect.Effect<ProjectionCheckpoint | undefined, SessionError>
  readonly saveProjection?: (
    seq: SessionSeq,
    derived: ReadonlyArray<DerivedMessage>,
  ) => Effect.Effect<void, SessionError>
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
  /**
   * Whether the log holds nothing but its header: a session nobody said anything
   * in. Absent reads as no, for a provider that cannot tell without reading all.
   */
  readonly empty?: boolean
}

/** The persistence seam. S1 provides a JSONL implementation in `@jozo-harness/session-jsonl`. */
export interface SessionPersistence {
  readonly create: (header: SessionHeader) => Effect.Effect<OpenedSession, SessionError>
  readonly open: (id: SessionId) => Effect.Effect<OpenedSession, SessionError>
  /**
   * Reads a session without claiming it for writing, so a reader can look at a
   * log another process is appending to. Absent means the store only opens it
   * for writing, and a reader then has to take that same path.
   */
  readonly read?: (id: SessionId) => Effect.Effect<ReadonlyArray<SessionEvent>, SessionError>
  readonly stat: (id: SessionId) => Effect.Effect<SessionSummary, SessionError>
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, SessionError>
}
