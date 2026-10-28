import type { AgentsShape } from '@jozo-harness/agent'
import { teamRoster, type TeamMessage } from './team-state.ts'

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

/**
 * The unread peer messages a teammate reads at the start of a step. The line asks
 * for an inbox call so one long turn does not replay the same message every step.
 */
export const teamInboxLine = (messages: ReadonlyArray<TeamMessage>): string | undefined =>
  messages.length === 0
    ? undefined
    : 'team inbox: ' +
      messages.map((message) => message.from + ': ' + message.text).join(' | ') +
      '. Reply with team send, or run team inbox to mark these read.'

/** The line a teammate reads on every request, however many turns it has taken. */
export const teamIdentityLine = (identity: TeamIdentity): string =>
  'team: you are teammate "' +
  identity.name +
  '"' +
  (identity.role.trim() === '' ? '' : ' (' + identity.role + ')') +
  '; your Team Lead is session ' +
  identity.lead +
  '. Act as that teammate, not as the lead.'
