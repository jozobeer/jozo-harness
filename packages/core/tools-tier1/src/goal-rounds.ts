import { Effect } from 'effect'
import type { Agent } from '@jozo-harness/agent'
import type { SessionEvent } from '@jozo-harness/session'
import {
  currentGoal,
  goalRounds,
  GOAL_ROUND_SOURCE,
  MIN_BLOCKED_ROUNDS,
  type GoalState,
} from './goal-state.ts'

/** What the driver decided to do about the goal at the end of a turn. */
export type GoalRoundDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'round'; readonly round: number; readonly text: string }
  | { readonly kind: 'limit'; readonly state: GoalState }

/** The continuation prompt of one round, kept in the log so the next round can read it. */
export const renderGoalRound = (goal: GoalState, round: number): string =>
  '<goal_round>\n' +
  'Objective: ' +
  goal.objective +
  '\n' +
  (goal.note === undefined ? '' : 'Note: ' + goal.note + '\n') +
  'Round: ' +
  String(round) +
  '/' +
  String(goal.maxGoalRounds) +
  '\n\n' +
  'Continue working toward the objective in this same session. Treat the current workspace, ' +
  'tool results, and durable session state as authoritative; inspect them instead of assuming ' +
  'earlier narration is still current. Make concrete progress and verify the result. Before ' +
  'claiming completion, gather evidence that the whole objective is achieved, read the current ' +
  'goal with the goal tool (action read), and mark it complete. If work remains, leave the goal ' +
  'active for the next round. Report ' +
  'blocked only after the same blocking condition has persisted for at least ' +
  String(MIN_BLOCKED_ROUNDS) +
  ' rounds.\n' +
  '</goal_round>'

/**
 * What the end of a turn means for the goal: nothing when there is no active goal,
 * the next round when there is room for one, and the limit when there is not.
 */
export const goalRoundDecision = (events: ReadonlyArray<SessionEvent>): GoalRoundDecision => {
  const goal = currentGoal(events)
  if (goal === undefined || goal.phase !== 'active') return { kind: 'none' }
  const rounds = goalRounds(events)
  if (rounds >= goal.maxGoalRounds) return { kind: 'limit', state: goal }
  const round = rounds + 1
  return { kind: 'round', round, text: renderGoalRound(goal, round) }
}

const blockAtLimit = (agent: Agent, state: GoalState): Effect.Effect<void> =>
  agent.session
    .append('goal/updated', {
      objective: state.objective,
      phase: 'blocked',
      maxGoalRounds: state.maxGoalRounds,
      blockedReason:
        'round-limit: the goal reached its limit of ' + String(state.maxGoalRounds) + ' rounds',
      ...(state.note === undefined ? {} : { note: state.note }),
    })
    .pipe(Effect.catchCause(() => Effect.void))

/**
 * Runs at the end of a turn of the goal's own agent: an active goal gets its next
 * round queued as a user message of its own, so the turn that follows starts on its
 * own, and a goal that has run its limit is stopped instead. Queueing before the
 * turn ends keeps the agent from settling in between, and the log stays the only
 * state the decision reads.
 */
export const startGoalRound = (agent: Agent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const decision = goalRoundDecision(agent.session.events())
    if (decision.kind === 'none') return
    if (decision.kind === 'limit') {
      yield* blockAtLimit(agent, decision.state)
      return
    }
    yield* agent
      .followup({ text: decision.text, source: GOAL_ROUND_SOURCE })
      .pipe(Effect.catchCause(() => Effect.void))
  })
