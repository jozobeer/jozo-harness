import {
  AttachmentSchema,
  QuoteSchema,
  ReferenceSchema,
  USER_MESSAGE_SOURCES,
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type Attachment,
  type Quote,
  type Reference,
  type SessionEventSchemaMap,
  type UserMessageSource,
} from '@jozo-harness/session'
import { Schema } from 'effect'

/** Which boundary picks up a queued message. */
export type InboxTarget = 'next-turn' | 'next-step'

/** One message waiting for an agent. */
export interface UserMessage {
  readonly text: string
  readonly source: UserMessageSource
  /** Passages the human quoted; they travel with the message to the log. */
  readonly quotes?: ReadonlyArray<Quote>
  /** Files and sessions the human attached with @; they travel with the message to the log. */
  readonly references?: ReadonlyArray<Reference>
  /** Files the human attached from the composer; they travel with the message to the log. */
  readonly attachments?: ReadonlyArray<Attachment>
}

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'agent/inbox/queued': { readonly target: InboxTarget; readonly message: UserMessage }
    'agent/inbox/claimed': { readonly target: InboxTarget; readonly message: UserMessage }
    'agent/inbox/dropped': { readonly target: InboxTarget; readonly message: UserMessage }
  }
}

const UserMessageSchema = Schema.Struct({
  text: Schema.String,
  // One list of sources, so a new one cannot be accepted here but refused by the log.
  source: Schema.Literals(USER_MESSAGE_SOURCES),
  quotes: Schema.optionalKey(Schema.Array(QuoteSchema)),
  references: Schema.optionalKey(Schema.Array(ReferenceSchema)),
  attachments: Schema.optionalKey(Schema.Array(AttachmentSchema)),
})

const InboxEventDataSchema = Schema.Struct({
  target: Schema.Literals(['next-turn', 'next-step']),
  message: UserMessageSchema,
})

/** Schemas for the session events this package adds. */
export const inboxEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  ['agent/inbox/queued', InboxEventDataSchema],
  ['agent/inbox/claimed', InboxEventDataSchema],
  ['agent/inbox/dropped', InboxEventDataSchema],
])

// Logs written here stay readable by every provider, not only by callers that
// pass the map explicitly.
registerSessionEventSchemas(inboxEventSchemas)
// The inbox is durable queue state: the message it carries is appended separately.
registerLogOnlySessionEvents(['agent/inbox/queued', 'agent/inbox/claimed', 'agent/inbox/dropped'])
