import type { Agent, AgentsShape } from '@jozo-harness/agent'
import type { RunStateView } from '@jozo-harness/web'
import { WebError } from '@jozo-harness/web'
import { Effect } from 'effect'

/** When a child stopped working: the last event it wrote, or absent while it works. */
const endedAtOf = (child: Agent): number | undefined =>
  child.status === 'running' || child.status === 'cancelling'
    ? undefined
    : child.session.events().at(-1)?.time

/** The children one session started, as the Run pane lists them. */
export const subagentsOf = (children: ReadonlyArray<Agent>): RunStateView['subagents'] =>
  children.map((child) => {
    const endedAt = endedAtOf(child)
    return {
      id: child.id,
      status: child.status,
      startedAt: child.session.header.createdAt,
      ...(child.options.preset === undefined ? {} : { preset: child.options.preset }),
      ...(endedAt === undefined ? {} : { endedAt }),
    }
  })

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
