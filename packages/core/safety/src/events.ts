import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type SessionEventSchemaMap,
} from '@jozo-harness/session'
import { Schema } from 'effect'

/** Asks the user to let one call run outside the preset. */
export interface ApprovalRequested {
  readonly callId: string
  readonly tool: string
  readonly reason: string
}

/** The answer to one request. Approval is one call wide, never remembered. */
export interface ApprovalAnswered {
  readonly callId: string
  readonly approved: boolean
}

/** One call the auto preset sent to review, and what the review decided. */
export interface AutoReviewed {
  readonly sessionId: string
  readonly callId: string
  readonly tool: string
  readonly decision: 'allowed' | 'denied'
  readonly reason?: string
}

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'safety/approval/requested': ApprovalRequested
    'safety/approval/answered': ApprovalAnswered
    'safety/auto/reviewed': AutoReviewed
  }
}

const ApprovalRequestedSchema = Schema.Struct({
  callId: Schema.String,
  tool: Schema.String,
  reason: Schema.String,
})

const ApprovalAnsweredSchema = Schema.Struct({
  callId: Schema.String,
  approved: Schema.Boolean,
})

const AutoReviewedSchema = Schema.Struct({
  sessionId: Schema.String,
  callId: Schema.String,
  tool: Schema.String,
  decision: Schema.Literals(['allowed', 'denied']),
  reason: Schema.optionalKey(Schema.String),
})

/** Schemas for the session events this package adds. */
export const approvalEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  ['safety/approval/requested', ApprovalRequestedSchema],
  ['safety/approval/answered', ApprovalAnsweredSchema],
  ['safety/auto/reviewed', AutoReviewedSchema],
])

// Logs written here stay readable by every provider, not only by callers that
// pass the map explicitly.
registerSessionEventSchemas(approvalEventSchemas)
// Approvals are shown by the UI and never join the model history. A review is
// the audit trail for the auto preset, not a message the model reads back.
registerLogOnlySessionEvents([
  'safety/approval/requested',
  'safety/approval/answered',
  'safety/auto/reviewed',
])
