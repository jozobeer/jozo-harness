import type { Agent, AgentsShape } from '@jozo-harness/agent'
import type { RunStateView, SubagentMessageView } from '@jozo-harness/web'
import { WebError } from '@jozo-harness/web'
import { Effect } from 'effect'

/** When a child stopped working: the last event it wrote, or absent while it works. */
const endedAtOf = (child: Agent): number | undefined =>
  child.status === 'running' || child.status === 'cancelling'
    ? undefined
    : child.session.events().at(-1)?.time

/** The children one session started, as the Run pane lists them, with where each sits. */
export const subagentsOf = (
  agents: AgentsShape,
  children: ReadonlyArray<Agent>,
  /** The deepest level this run allows; a row reads it to say whether a child may start one. */
  maxDepth: number,
): RunStateView['subagents'] =>
  children.map((child) => {
    const endedAt = endedAtOf(child)
    return {
      id: child.id,
      status: child.status,
      startedAt: child.session.header.createdAt,
      depth: agents.depthOf(child.id),
      maxDepth,
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

/**
 * Sends one child this session started a follow-up, the way the model's
 * send_message does: an idle child starts a new turn with it, and a child that
 * is working reads it at its next step boundary. A child another session
 * started, or an id nobody holds, is refused without saying which session owns it.
 */
export const messageSubagentOf = (
  agents: AgentsShape,
  parent: string,
  id: string,
  message: string,
): Effect.Effect<SubagentMessageView, WebError> =>
  Effect.gen(function* () {
    const child = agents.childrenOf(parent).find((each) => each.id === id)
    if (child === undefined) {
      return yield* Effect.fail(new WebError({ message: 'the subagent is not running' }))
    }
    const taken = (): WebError => new WebError({ message: 'the subagent took no message: ' + id })
    const line = { text: message, source: 'user' as const }
    // A child mid-turn keeps its turn; the message waits for the next step
    // boundary, so the page reports it as queued rather than as a new turn.
    if (child.status !== 'idle') {
      yield* child.steer(line).pipe(Effect.mapError(taken))
      return { id, queued: true }
    }
    yield* child.followup(line).pipe(Effect.mapError(taken))
    return { id, queued: false }
  })
