import type { AgentsShape } from '@jozo-harness/agent'
import { ToolError } from '@jozo-harness/tools'
import { teamIdentityOf } from './team-identity.ts'

/** Who is calling team: the lead that owns a roster, or one of its named teammates. */
export interface TeamActor {
  readonly kind: 'lead' | 'teammate'
  /** The roster name, or "lead" for the session that owns the roster. */
  readonly name: string
  readonly sessionId: string
  /** The log that holds the roster and the board: always the lead's session. */
  readonly boardSession: string
}

/**
 * Resolves the caller against the live rosters. A session on no roster is the lead
 * of its own board, so a plain subagent keeps a private board instead of acting on
 * a team it was never added to.
 */
export const teamActorOf = (agents: AgentsShape, sessionId: string): TeamActor => {
  const identity = teamIdentityOf(agents, sessionId)
  return identity === undefined
    ? { kind: 'lead', name: 'lead', sessionId, boardSession: sessionId }
    : { kind: 'teammate', name: identity.name, sessionId, boardSession: identity.lead }
}

/**
 * Refuses an action the lead keeps for itself. The message names what a teammate
 * can do instead, because a bare refusal leaves the model retrying the same call.
 */
export const leadOnlyRefusal = (
  actor: TeamActor,
  action: string,
  instead: string,
): ToolError | undefined =>
  actor.kind === 'lead'
    ? undefined
    : new ToolError({
        code: 'denied',
        message: 'team ' + action + " is the Team Lead's. " + instead,
      })
