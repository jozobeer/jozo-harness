import type { RequestMessage } from '@jozo-harness/llm'
import {
  continueMessagesWithSeqs,
  deriveMessagesWithSeqs,
  type DerivedMessage,
} from './derive.ts'
import type { SessionEvent, SessionSeq } from './events.ts'
import type { MessageProjection } from './projections.ts'

/** The checkpoint layout this build writes. A file with another number is stale. */
export const PROJECTION_CHECKPOINT_VERSION = 1

/**
 * A projection saved beside the log. The seq is how far the fold got, the derived
 * messages are what it had produced, and the log stamp catches a rewritten log.
 * It is a cache: the log stays the only source of truth.
 */
export interface ProjectionCheckpoint {
  readonly version: typeof PROJECTION_CHECKPOINT_VERSION
  readonly seq: SessionSeq
  readonly log: {
    readonly mtimeMs: number
    readonly size: number
  }
  readonly derived: ReadonlyArray<DerivedMessage>
}

/** What one open produced: the messages, and how much of the log it had to fold. */
export interface ResumedProjection {
  readonly derived: ReadonlyArray<DerivedMessage>
  /** Events folded on this open; the whole log when the checkpoint was unusable. */
  readonly folded: number
  readonly resumed: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isMessage = (value: unknown): value is RequestMessage =>
  isRecord(value) && typeof value.role === 'string' && Array.isArray(value.content)

const isDerived = (value: unknown, seq: number): value is DerivedMessage =>
  isRecord(value) &&
  typeof value.seq === 'number' &&
  Number.isInteger(value.seq) &&
  value.seq >= 1 &&
  value.seq <= seq &&
  isMessage(value.message)

const isLogStamp = (value: unknown): value is ProjectionCheckpoint['log'] =>
  isRecord(value) &&
  typeof value.mtimeMs === 'number' &&
  Number.isFinite(value.mtimeMs) &&
  typeof value.size === 'number' &&
  Number.isInteger(value.size) &&
  value.size >= 0

/**
 * Reads one checkpoint. A file this build cannot understand is a miss, not an
 * error: the caller folds the whole log instead of refusing the session.
 */
export function decodeProjectionCheckpoint(value: unknown): ProjectionCheckpoint | undefined {
  if (!isRecord(value)) return undefined
  if (value.version !== PROJECTION_CHECKPOINT_VERSION) return undefined
  const seq = value.seq
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return undefined
  const log = value.log
  if (!isLogStamp(log)) return undefined
  if (!Array.isArray(value.derived)) return undefined
  const derived: Array<DerivedMessage> = []
  for (const entry of value.derived) {
    if (!isDerived(entry, seq)) return undefined
    derived.push(entry)
  }
  return { version: PROJECTION_CHECKPOINT_VERSION, seq, log, derived }
}

/** Serialises a checkpoint; the writer replaces the old file in one rename. */
export const encodeProjectionCheckpoint = (checkpoint: ProjectionCheckpoint): string =>
  JSON.stringify(checkpoint)

/**
 * Folds only what the checkpoint does not cover. A checkpoint whose seq is absent
 * from the log, or one that cannot be applied, falls back to the whole log.
 */
export function resumeProjection(
  events: ReadonlyArray<SessionEvent>,
  checkpoint: ProjectionCheckpoint | undefined,
  extra: ReadonlyArray<MessageProjection> = [],
): ResumedProjection {
  const at = checkpoint === undefined ? -1 : events.findIndex((event) => event.seq === checkpoint.seq)
  if (checkpoint === undefined || at < 0) {
    return {
      derived: deriveMessagesWithSeqs(events, extra),
      folded: events.length,
      resumed: false,
    }
  }
  const tail = events.slice(at + 1)
  return {
    derived: continueMessagesWithSeqs(tail, checkpoint.derived, extra),
    folded: tail.length,
    resumed: true,
  }
}
