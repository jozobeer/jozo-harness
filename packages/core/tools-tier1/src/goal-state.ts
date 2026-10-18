import { Schema } from 'effect'
import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type SessionEvent,
  type SessionEventSchemaMap,
  type UserMessageSource,
} from '@jozo-harness/session'

/** Where a goal stands. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** The objective a session is working toward, as the log last recorded it. */
export interface GoalState {
  readonly objective: string
  readonly note?: string
  readonly phase: GoalPhase
  readonly maxGoalRounds: number
  /** Present only while the phase is blocked. */
  readonly blockedReason?: string
}

/** How many rounds a goal may run before the driver stops it. */
export const DEFAULT_MAX_GOAL_ROUNDS = 256
/** How many rounds a blocker must persist through before an automatic round may report it. */
export const MIN_BLOCKED_ROUNDS = 3
/** The source of the message the driver sends to start a round. */
export const GOAL_ROUND_SOURCE = 'goal-round'

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'goal/updated': GoalState
  }
}

const GoalStateSchema = Schema.Struct({
  objective: Schema.String,
  note: Schema.optionalKey(Schema.String),
  phase: Schema.Literals(['active', 'paused', 'blocked', 'complete']),
  maxGoalRounds: Schema.Int,
  blockedReason: Schema.optionalKey(Schema.String),
})

/** Schemas for the session events this module adds. */
export const goalEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  ['goal/updated', GoalStateSchema],
])

registerSessionEventSchemas(goalEventSchemas)
// The goal is for the driver and the UI; the model reads it from the tool result.
registerLogOnlySessionEvents(['goal/updated'])

/** The goal the log recorded last, or nothing when this session never had one. */
export const currentGoal = (events: ReadonlyArray<SessionEvent>): GoalState | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'goal/updated') return event.data
  }
  return undefined
}

/** How many rounds the driver has started; counted from the log, never stored. */
export const goalRounds = (events: ReadonlyArray<SessionEvent>): number =>
  events.filter((event) => event.type === 'user/message' && event.data.source === GOAL_ROUND_SOURCE)
    .length

/** The events of the turn that is still open: everything after the last `turn/start`. */
const openTurn = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<SessionEvent> => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') return events.slice(index + 1)
  }
  return events
}

/** Whether the open turn carries an input that came from this source. */
export const turnHasSource = (
  events: ReadonlyArray<SessionEvent>,
  source: UserMessageSource,
): boolean =>
  openTurn(events).some((event) => event.type === 'user/message' && event.data.source === source)

/**
 * Whether the open turn began with a person typing: the only authority for pause
 * and resume. A command the person ran is their word too, even when no turn has
 * started yet.
 */
export const inHumanTurn = (events: ReadonlyArray<SessionEvent>): boolean =>
  turnHasSource(events, 'user') || openTurn(events).some((event) => event.type === 'command/run')

/** Whether the open turn is one the goal driver started, rather than a person. */
export const inGoalRound = (events: ReadonlyArray<SessionEvent>): boolean =>
  turnHasSource(events, GOAL_ROUND_SOURCE)
