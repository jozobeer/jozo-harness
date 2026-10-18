import type { AgentsShape } from '@jozo-harness/agent'
import { teamRoster } from './team-state.ts'

/** Sits between the workspace fact and the delegation fact in a runtime snapshot. */
export const TEAM_IDENTITY_CONTEXT_ORDER = 15

/** Who a teammate is, as the lead's roster records it. */
export interface TeamIdentity {
  readonly name: string
  readonly role: string
  /** The session id of the lead that spawned this teammate. */
  readonly lead: string
}

/**
 * The identity the roster of a live agent records for this session. A session
 * outside every roster, such as a lead or a plain subagent, has none.
 */
export const teamIdentityOf = (
  agents: AgentsShape,
  sessionId: string,
): TeamIdentity | undefined => {
  for (const agent of agents.list()) {
    if (agent.id === sessionId) continue
    const member = teamRoster(agent.session.events()).find((each) => each.sessionId === sessionId)
    if (member !== undefined) return { name: member.name, role: member.role, lead: agent.id }
  }
  return undefined
}

/** The line a teammate reads on every request, however many turns it has taken. */
export const teamIdentityLine = (identity: TeamIdentity): string =>
  'team: you are teammate "' +
  identity.name +
  '"' +
  (identity.role.trim() === '' ? '' : ' (' + identity.role + ')') +
  '; your Team Lead is session ' +
  identity.lead +
  '. Act as that teammate, not as the lead.'
