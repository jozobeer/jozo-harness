import type { Agent, AgentsShape } from '@jozo-harness/agent'
import type { RunStateView } from '@jozo-harness/web'
import { WebError } from '@jozo-harness/web'
import { Effect } from 'effect'

/** The children one session started, as the Run pane lists them. */
export const subagentsOf = (children: ReadonlyArray<Agent>): RunStateView['subagents'] =>
  children.map((child) => ({
    id: child.id,
    status: child.status,
    startedAt: child.session.header.createdAt,
  }))

/**
 * Stops one child this session started. A child another session started, or an
 * id nobody holds, is refused without saying which session owns it.
 */
export const stopSubagentOf = (
  agents: AgentsShape,
  parent: string,
  id: string,
): Effect.Effect<void, WebError> =>
  Effect.gen(function* () {
    const child = agents.childrenOf(parent).find((each) => each.id === id)
    if (child === undefined) {
      return yield* Effect.fail(new WebError({ message: 'the subagent is not running' }))
    }
    yield* child.cancel('user')
  })
