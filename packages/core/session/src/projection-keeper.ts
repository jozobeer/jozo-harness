import { Effect } from 'effect'
import { continueMessagesWithSeqs, deriveMessagesWithSeqs, type DerivedMessage } from './derive.ts'
import type { SessionEvent } from './events.ts'
import type { SessionSink } from './persistence.ts'
import { resumeProjection, type ProjectionCheckpoint } from './projection-checkpoint.ts'

/** A checkpoint is due after this many appended events, or this much time. */
const CHECKPOINT_EVENTS = 200
const CHECKPOINT_INTERVAL_MS = 5_000

/** The fold's state as of the last checkpoint. */
interface FoldBase {
  readonly seq: number
  readonly derived: ReadonlyArray<DerivedMessage>
}

/**
 * Keeps the fold state a checkpoint will hold and decides when to write it. The
 * session says what was appended; this owns the 200-event and five-second budget.
 */
export interface ProjectionKeeper {
  /** The messages the loaded checkpoint already covers, when it resumed. */
  readonly messages: () => ReadonlyArray<DerivedMessage> | undefined
  /** Folds one appended event, or gives the state up when its projection is missing. */
  readonly appended: (event: SessionEvent) => void
  readonly due: () => boolean
  /** Serialises the state; a failed write is swallowed because it is only a cache. */
  readonly save: (log: ReadonlyArray<SessionEvent>, highest: number) => Effect.Effect<void>
  /** Takes a fold that derive() just built, so the next save needs no rebuild. */
  readonly adopt: (derived: ReadonlyArray<DerivedMessage>, seq: number) => void
}

/**
 * Opens the checkpoint a sink keeps. A sink without both hooks leaves the session
 * folding the whole log on every open, which is the path a new provider starts on.
 */
export const makeProjectionKeeper = (
  sink: SessionSink,
  events: ReadonlyArray<SessionEvent>,
  now: () => number,
): Effect.Effect<ProjectionKeeper | undefined> =>
  Effect.gen(function* () {
    const saveProjection = sink.saveProjection
    const loadProjection = sink.loadProjection
    if (saveProjection === undefined) return undefined
    let base: FoldBase | undefined
    let sinceWrite = 0
    let lastWriteAt = now()
    const stored =
      loadProjection === undefined
        ? undefined
        : yield* loadProjection().pipe(
            Effect.catchCause(() => Effect.succeed<ProjectionCheckpoint | undefined>(undefined)),
          )
    if (stored !== undefined) {
      try {
        const resumed = resumeProjection(events, stored)
        if (resumed.resumed) base = { seq: stored.seq, derived: resumed.derived }
      } catch {
        // A tail this process cannot project is not a reason to refuse the open;
        // derive() reports it the way a full fold always has.
        base = undefined
      }
    }

    const save = (log: ReadonlyArray<SessionEvent>, highest: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (base === undefined) {
          // Without a state to serialize, the first save pays for one fold of the
          // log; later saves fold only what was appended since.
          try {
            base = { seq: highest, derived: deriveMessagesWithSeqs(log) }
          } catch {
            base = undefined
          }
        }
        const state = base
        // Count the attempt even when the fold failed, so an event whose plugin
        // is missing does not make every later append retry the whole log.
        sinceWrite = 0
        lastWriteAt = now()
        if (state === undefined) return
        yield* saveProjection(state.seq, state.derived).pipe(Effect.ignore)
      })

    return {
      messages: () => base?.derived,
      appended: (event) => {
        sinceWrite += 1
        if (base === undefined) return
        try {
          base = { seq: event.seq, derived: continueMessagesWithSeqs([event], base.derived) }
        } catch {
          base = undefined
        }
      },
      due: () => sinceWrite >= CHECKPOINT_EVENTS || now() - lastWriteAt >= CHECKPOINT_INTERVAL_MS,
      save,
      adopt: (derived, seq) => {
        base = { seq, derived }
      },
    }
  })
