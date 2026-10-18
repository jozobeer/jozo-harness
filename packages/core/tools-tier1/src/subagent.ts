import { forkSeed } from '@jozo-harness/session'
import { childAnswerOf } from './child-answer.ts'
import { delegationRefusal, eventsOfAgent } from './delegation.ts'
import { Schema, Effect } from 'effect'
import type { AgentsShape } from '@jozo-harness/agent'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const Parameters = Schema.Struct({
  task: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The whole task for the child, written as if the child sees nothing else. Leave it out to start a child that waits for send_message.',
    }),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The directory the child starts in. Defaults to this working directory.',
    }),
  ),
  model: Schema.optionalKey(
    Schema.String.annotate({
      description: "The route the child runs on, provider/model. Defaults to this agent's route.",
    }),
  ),
  context: Schema.optionalKey(
    Schema.Literals(['fork', 'fresh']).annotate({
      description:
        "Whether the child starts from this conversation's log (fork, the default) or from nothing (fresh).",
    }),
  ),
})

/** The route a child runs on: the one asked for, checked, or this agent's own. */
const routeFor = (asked: string | undefined, fallback: string): string | ToolError => {
  if (asked === undefined) return fallback
  const slash = asked.indexOf('/')
  if (slash <= 0 || slash === asked.length - 1) {
    return new ToolError({
      code: 'invalid-arguments',
      message: 'a route names a provider and a model, like provider/model: ' + asked,
    })
  }
  return asked.slice(0, slash) + '/' + asked.slice(slash + 1)
}

export type SubagentArgs = Schema.Schema.Type<typeof Parameters>

export interface SubagentValue {
  readonly sessionId: string
  readonly text: string
}

/**
 * Runs one task in a child agent and answers with what it said. The child owns
 * its own session, so its work stays in the log next to the parent's.
 */
export interface SubagentHost {
  readonly agents: AgentsShape
  readonly route: string
}

export const makeSubagentTool = (
  host: SubagentHost,
): ToolDefinition<SubagentArgs, SubagentValue> => {
  const { agents } = host
  return {
    name: 'subagent',
    description:
      "Starts a child agent with one task and returns what it said, or starts it with no task and leaves it idle for send_message. The child runs on this agent's route unless another one is named, and starts from this conversation (fork) or from nothing (fresh).",
    parameters: Parameters,
    output: {
      schema: Schema.Struct({ sessionId: Schema.String, text: Schema.String }),
      // The session id rides along, so the parent can send the child more work or wait for it.
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.text === ''
              ? '(the child is idle; send it work with send_message)'
              : value.text) +
            '\n\n[child session: ' +
            value.sessionId +
            ']',
        },
      ],
    },
    execute: (args, context) =>
      Effect.gen(function* () {
        const refused = delegationRefusal(agents, context.sessionId)
        if (refused !== undefined) return yield* Effect.fail(refused)
        const route = routeFor(args.model, host.route)
        if (route instanceof ToolError) return yield* Effect.fail(route)
        const child = yield* agents
          .create({
            cwd: args.cwd ?? context.cwd,
            options: { route },
            seed:
              args.context === 'fresh' ? [] : forkSeed(eventsOfAgent(agents, context.sessionId)),
            parent: context.sessionId,
          })
          .pipe(
            Effect.mapError(
              () => new ToolError({ code: 'execution', message: 'cannot start a child agent' }),
            ),
          )
        if (args.task === undefined) return { sessionId: child.id, text: '' }
        yield* child
          .followup({ text: args.task, source: 'user' })
          .pipe(
            Effect.mapError(
              () =>
                new ToolError({ code: 'execution', message: 'the child agent took no message' }),
            ),
          )
        yield* child.whenIdle
        return { sessionId: child.id, text: childAnswerOf(child) }
      }),
  }
}
