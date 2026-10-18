import type { SessionEvent, SessionSeq } from './events.ts'

/** The newest system message in the log, or nothing when no frame was recorded yet. */
export const lastSystemMessage = (
  events: ReadonlyArray<SessionEvent>,
): Extract<SessionEvent, { readonly type: 'system/message' }> | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'system/message') return event
  }
  return undefined
}

/** The newest system prompt; the loop appends one only when it changes. */
export const lastSystemPrompt = (events: ReadonlyArray<SessionEvent>): string | undefined =>
  lastSystemMessage(events)?.data.text

/**
 * Where the frame sits in the fold: the newest system prompt alone is the request's
 * frame. An older one is what the model was given earlier, so compaction may fold it.
 */
export const latestSystemSeq = (events: ReadonlyArray<SessionEvent>): SessionSeq | undefined =>
  lastSystemMessage(events)?.seq
