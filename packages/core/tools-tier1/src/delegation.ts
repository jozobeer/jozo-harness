import type { AgentsShape } from '@jozo-harness/agent'
import type { SessionEvent } from '@jozo-harness/session'
import { ToolError } from '@jozo-harness/tools'

/**
 * How many levels of delegation a run allows below the agent it started: a child
 * may not start a child of its own unless a caller raises this.
 */
export const DELEGATION_MAX_DEPTH = 1

/** Sits between the workspace facts and the clock in a runtime snapshot. */
export const DELEGATION_CONTEXT_ORDER = 20

/** A limit that reads the run's current setting, so a change reaches the next call. */
export type DepthLimit = number | (() => number)

const limitOf = (limit: DepthLimit): number => (typeof limit === 'function' ? limit() : limit)

/** The line an agent at the limit reads; below the limit there is nothing to say. */
export const delegationLine = (
  depth: number,
  maxDepth: DepthLimit = DELEGATION_MAX_DEPTH,
): string | undefined => {
  const limit = limitOf(maxDepth)
  return depth < limit
    ? undefined
    : 'Delegation depth for subagent: current ' +
        String(depth) +
        ', maximum ' +
        String(limit) +
        ', remaining levels 0. Do not call subagent at this depth; carry out the work directly.'
}

/** Why this call may not start a child, or nothing when it still may. */
export const delegationRefusal = (
  agents: AgentsShape,
  sessionId: string,
  maxDepth: DepthLimit = DELEGATION_MAX_DEPTH,
): ToolError | undefined => {
  const limit = limitOf(maxDepth)
  return agents.depthOf(sessionId) < limit
    ? undefined
    : new ToolError({
        code: 'execution',
        message:
          'delegation depth is at its limit (' +
          String(limit) +
          '): carry out this work directly instead of starting a child',
      })
}

/**
 * The log of the agent making the call. A fork reads this agent's conversation,
 * not the root's, and a team board writes to the same session the caller owns.
 */
export const eventsOfAgent = (
  agents: AgentsShape,
  sessionId: string,
): ReadonlyArray<SessionEvent> => agents.get(sessionId)?.session.events() ?? []
