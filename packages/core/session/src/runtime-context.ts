import type { SessionEvent, SessionSeq } from './events.ts'

/** The seqs a recorded checkpoint folded away, so the request no longer carries them. */
const checkpointShadowedSeqs = (events: ReadonlyArray<SessionEvent>): ReadonlySet<SessionSeq> => {
  const shadowed = new Set<SessionSeq>()
  for (const event of events) {
    if (event.type !== 'compaction/checkpoint') continue
    for (const seq of event.data.shadowedSeqs) shadowed.add(seq)
  }
  return shadowed
}

/**
 * The newest runtime snapshot the request still carries. A checkpoint may have
 * folded an older one; the loop then records a fresh snapshot instead of trusting
 * the summary to say who is asking.
 */
const liveRuntimeContext = (
  events: ReadonlyArray<SessionEvent>,
): (SessionEvent & { readonly type: 'user/message' }) | undefined => {
  const shadowed = checkpointShadowedSeqs(events)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      event?.type === 'user/message' &&
      event.data.source === 'runtime-context' &&
      !shadowed.has(event.seq)
    ) {
      return event
    }
  }
  return undefined
}

/** The seq of the newest live snapshot, so a summary leaves it in the request. */
export const lastRuntimeContextSeq = (
  events: ReadonlyArray<SessionEvent>,
): SessionSeq | undefined => liveRuntimeContext(events)?.seq

/** The newest live runtime snapshot; the loop appends only when it changes. */
export const lastRuntimeContext = (events: ReadonlyArray<SessionEvent>): string | undefined =>
  liveRuntimeContext(events)?.data.text
