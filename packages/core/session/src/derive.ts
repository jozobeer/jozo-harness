import type { RequestMessage } from '@jozo-harness/llm'
import { SessionError } from './errors.ts'
import type { SessionEvent, SessionEventType, SessionSeq } from './events.ts'
import { logOnlyEventTypes, messageProjections, type MessageProjection } from './projections.ts'
import { renderUserText } from './quote.ts'

/** One model message with the event that produced it; pruning needs the seq back. */
export interface DerivedMessage {
  readonly seq: SessionSeq
  readonly message: RequestMessage
}

/** The event types the fold turns into a message by itself. */
const MESSAGE_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set([
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const toMessage = (event: SessionEvent): ReadonlyArray<RequestMessage> => {
  switch (event.type) {
    case 'system/message':
      return [{ role: 'system', content: [{ type: 'text', text: event.data.text }] }]
    case 'user/message':
      return [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: renderUserText(event.data.text, event.data.quotes, event.data.references),
            },
          ],
        },
      ]
    case 'assistant/message':
      return [{ role: 'assistant', content: event.data.content }]
    case 'tool/result':
      return [{ role: 'tool', toolCallId: event.data.callId, content: event.data.content }]
    default:
      return []
  }
}

/** What one event contributes to the fold. */
type EventStep =
  | { readonly kind: 'project'; readonly projection: MessageProjection }
  | { readonly kind: 'messages' }
  | { readonly kind: 'none' }

/**
 * Decides how one event reaches the history. A registered projection owns its type,
 * the core message types fold by themselves, a declared log-only type contributes
 * nothing, and any other type fails the fold: a plugin's event must not disappear
 * quietly.
 */
const stepOf = (
  event: SessionEvent,
  projections: ReadonlyMap<SessionEventType, MessageProjection>,
  logOnly: ReadonlySet<SessionEventType>,
): EventStep => {
  const projection = projections.get(event.type)
  if (projection !== undefined) return { kind: 'project', projection }
  if (MESSAGE_EVENT_TYPES.has(event.type)) return { kind: 'messages' }
  if (logOnly.has(event.type)) return { kind: 'none' }
  throw new SessionError({
    code: 'projection',
    message:
      'session event "' +
      event.type +
      '" needs a message projection: load the plugin that owns it, or declare it log-only',
  })
}

/**
 * Folds an event log into model history, keeping the event each message came from.
 * `extra` projections win over the registered ones of the same type.
 */
const projectionMap = (
  extra: ReadonlyArray<MessageProjection>,
): ReadonlyMap<SessionEventType, MessageProjection> => {
  if (extra.length === 0) return messageProjections()
  const merged = new Map(messageProjections())
  for (const item of extra) merged.set(item.type, item)
  return merged
}

/** Folds one event into the history derived so far. */
const foldOne = (
  derived: ReadonlyArray<DerivedMessage>,
  event: SessionEvent,
  projections: ReadonlyMap<SessionEventType, MessageProjection>,
  logOnly: ReadonlySet<SessionEventType>,
): ReadonlyArray<DerivedMessage> => {
  const step = stepOf(event, projections, logOnly)
  if (step.kind === 'none') return derived
  if (step.kind === 'project') return step.projection.project(event, derived)
  return [...derived, ...toMessage(event).map((message) => ({ seq: event.seq, message }))]
}

export function deriveMessagesWithSeqs(
  events: ReadonlyArray<SessionEvent>,
  extra: ReadonlyArray<MessageProjection> = [],
): ReadonlyArray<DerivedMessage> {
  const projections = projectionMap(extra)
  const logOnly = logOnlyEventTypes()
  let derived: ReadonlyArray<DerivedMessage> = []
  for (const event of events) derived = foldOne(derived, event, projections, logOnly)
  return derived
}

/** The events a recorded prune already shadows; a later prune leaves them alone. */
export const prunedSeqs = (events: ReadonlyArray<SessionEvent>): ReadonlySet<SessionSeq> => {
  const seqs = new Set<SessionSeq>()
  for (const event of events) {
    if (event.type !== 'compaction/prune') continue
    for (const replacement of event.data.replacements) seqs.add(replacement.seq)
  }
  return seqs
}

/** Folds an event log into the model history. The log is the only source. */
export function deriveMessages(
  events: ReadonlyArray<SessionEvent>,
  projections: ReadonlyArray<MessageProjection> = [],
): ReadonlyArray<RequestMessage> {
  return deriveMessagesWithSeqs(events, projections).map((entry) => entry.message)
}
