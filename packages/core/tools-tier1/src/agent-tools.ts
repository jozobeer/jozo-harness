import { Duration, Schema, Effect } from 'effect'
import type { Agent, AgentsShape } from '@jozo-harness/agent'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

/** How long wait_agent waits before it reports a child still working. */
export const WAIT_AGENT_DEFAULT_MS = 300_000

const IdParameters = Schema.Struct({
  id: Schema.String.annotate({
    description: 'The session id of the child agent, as the subagent tool answered it.',
  }),
})

/** Resolves the child a call names, refusing the caller itself and agents it did not start. */
const childOf = (
  agents: AgentsShape,
  sessionId: string,
  id: string,
): Effect.Effect<Agent, ToolError> =>
  Effect.gen(function* () {
    if (id === sessionId) {
      return yield* Effect.fail(
        new ToolError({
          code: 'invalid-arguments',
          message: 'that is this session, not a child agent: ' + id,
        }),
      )
    }
    const child = agents.childrenOf(sessionId).find((agent) => agent.id === id)
    if (child === undefined) {
      // An agent of another session is not this caller's to reach, so it is
      // refused without telling the caller which session started it.
      if (agents.get(id) !== undefined) {
        return yield* Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'not a child of this session: ' + id,
          }),
        )
      }
      return yield* Effect.fail(
        new ToolError({ code: 'execution', message: 'unknown agent: ' + id }),
      )
    }
    return child
  })

/** One child as the model sees it in the list. */
export interface AgentSummary {
  readonly id: string
  readonly status: string
}

/** Lists the child agents this session started. */
export const makeListAgentsTool = (
  agents: AgentsShape,
): ToolDefinition<Record<string, never>, ReadonlyArray<AgentSummary>> => ({
  name: 'list_agents',
  description:
    'Lists the child agents this session started and what each is doing. Use it to find a child id again before sending it a message or waiting for it.',
  parameters: Schema.Struct({}),
  output: {
    schema: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
    render: (_args, value) => [
      {
        type: 'text',
        text:
          value.length === 0
            ? '(no other agents)'
            : value.map((agent) => agent.id + ' ' + agent.status).join('\n'),
      },
    ],
  },
  execute: (_args, context) =>
    Effect.sync(() =>
      agents.childrenOf(context.sessionId).map((agent) => ({ id: agent.id, status: agent.status })),
    ),
})

/** Sends a child agent a message: a new turn when it is idle, the next step while it works. */
export const makeSendMessageTool = (
  agents: AgentsShape,
): ToolDefinition<{ id: string; message: string }, { id: string; queued: boolean }> => ({
  name: 'send_message',
  description:
    'Sends a message to a child agent this session started. A child that is idle starts a new turn with it; a child that is working reads it at its next step boundary.',
  parameters: Schema.Struct({
    id: Schema.String.annotate({ description: 'The session id of the child agent.' }),
    message: Schema.String.annotate({ description: 'What to tell the child.' }),
  }),
  output: {
    schema: Schema.Struct({ id: Schema.String, queued: Schema.Boolean }),
    render: (_args, value) => [
      {
        type: 'text',
        text: value.queued ? 'queued for ' + value.id + ' (it is working)' : 'sent to ' + value.id,
      },
    ],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const child = yield* childOf(agents, context.sessionId, args.id)
      const message = { text: args.message, source: 'user' as const }
      const taken = (): ToolError =>
        new ToolError({ code: 'execution', message: 'the child agent took no message: ' + args.id })
      if (child.status !== 'idle') {
        yield* child.steer(message).pipe(Effect.mapError(taken))
        return { id: args.id, queued: true }
      }
      yield* child.followup(message).pipe(Effect.mapError(taken))
      return { id: args.id, queued: false }
    }),
})

/** Stops what a child agent is doing, without disposing of it. */
export const makeInterruptAgentTool = (
  agents: AgentsShape,
): ToolDefinition<{ id: string }, { id: string }> => ({
  name: 'interrupt_agent',
  description:
    'Stops what a child agent is doing right now. The child keeps its session; the parent sees the turn end as cancelled by its parent.',
  parameters: IdParameters,
  output: {
    schema: Schema.Struct({ id: Schema.String }),
    render: (_args, value) => [{ type: 'text', text: 'interrupted ' + value.id }],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const child = yield* childOf(agents, context.sessionId, args.id)
      yield* child.cancel('parent-cancelled')
      return { id: args.id }
    }),
})

/** Waits for a child agent to finish what it is doing, up to a timeout. */
export const makeWaitAgentTool = (
  agents: AgentsShape,
): ToolDefinition<{ id: string; timeoutMs?: number }, { id: string; idle: boolean }> => ({
  name: 'wait_agent',
  description:
    'Waits until a child agent has finished its turn. Answers whether it is idle; a child that is still working after the timeout is reported as such rather than waited on forever.',
  parameters: Schema.Struct({
    id: Schema.String.annotate({ description: 'The session id of the child agent.' }),
    timeoutMs: Schema.optionalKey(
      Schema.Int.annotate({ description: 'The most milliseconds to wait. Defaults to 300000.' }),
    ),
  }),
  output: {
    schema: Schema.Struct({ id: Schema.String, idle: Schema.Boolean }),
    render: (_args, value) => [
      {
        type: 'text',
        text: value.idle ? value.id + ' is idle' : value.id + ' is still working after the wait',
      },
    ],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const child = yield* childOf(agents, context.sessionId, args.id)
      const timeoutMs = args.timeoutMs ?? WAIT_AGENT_DEFAULT_MS
      const idle = yield* Effect.race(
        child.whenIdle.pipe(Effect.as(true)),
        Effect.sleep(Duration.millis(Math.max(timeoutMs, 1))).pipe(Effect.as(false)),
      )
      return { id: args.id, idle }
    }),
})

/** The tools that steer child agents over one registry the caller owns. */
export const agentTools = (agents: AgentsShape): ReadonlyArray<ToolDefinition<any, any>> => [
  makeListAgentsTool(agents),
  makeSendMessageTool(agents),
  makeInterruptAgentTool(agents),
  makeWaitAgentTool(agents),
]
