import { forkSeed } from '@jozo-harness/session'
import { childAnswerOf } from './child-answer.ts'
import type { StructuredOutputs } from './structured-output.ts'
import {
  DELEGATION_MAX_DEPTH,
  delegationRefusal,
  eventsOfAgent,
  type DepthLimit,
} from './delegation.ts'
import { Schema, Effect } from 'effect'
import type { Agent, AgentsShape } from '@jozo-harness/agent'
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
      description:
        "The route the child runs on, provider/model. It has to be one this run offers. Defaults to this agent's route.",
    }),
  ),
  context: Schema.optionalKey(
    Schema.Literals(['fork', 'fresh']).annotate({
      description:
        "Whether the child starts from this conversation's log (fork, the default) or from nothing (fresh).",
    }),
  ),
  preset: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The named agent preset the child runs under. It has to be one the profile allows, and leaving it out takes the profile default.',
    }),
  ),
  outputSchema: Schema.optionalKey(
    Schema.JsonObject.annotate({
      description:
        'A JSON Schema the child has to answer with through structured_output. The result then carries the checked value; a child that never reports fails the call.',
    }),
  ),
})

/** The asked route with the repeated separator taken out, when it names a provider and a model. */
const shapedRoute = (asked: string): string | undefined => {
  const slash = asked.indexOf('/')
  if (slash <= 0 || slash === asked.length - 1) return undefined
  return asked.slice(0, slash) + '/' + asked.slice(slash + 1)
}

/** The refusal a run gives a route it does not offer children. */
const routeRefusal = (route: string, offered: ReadonlyArray<string>): ToolError =>
  new ToolError({
    code: 'invalid-arguments',
    message:
      'not a route this run offers children: ' +
      route +
      (offered.length === 0 ? '' : ' (offered: ' + offered.join(', ') + ')'),
  })

/** The route a child runs on: the one asked for, checked against what the run offers, or this agent's own. */
const routeFor = (
  asked: string | undefined,
  fallback: string,
  offered: ReadonlyArray<string> | undefined,
): string | ToolError => {
  if (asked === undefined) return fallback
  // The run's own settings name routes both with and without a provider, so an
  // offered route is taken exactly as the run spells it.
  if (offered?.includes(asked) === true) return asked
  const route = shapedRoute(asked)
  if (route === undefined) {
    return new ToolError({
      code: 'invalid-arguments',
      message: 'a route names a provider and a model, like provider/model: ' + asked,
    })
  }
  // A host that cannot list its routes leaves the shape as the only check, so a
  // child can still be pointed at a route the host did not enumerate.
  if (offered !== undefined && !offered.includes(route)) return routeRefusal(route, offered)
  return route
}

export type SubagentArgs = Schema.Schema.Type<typeof Parameters>

export interface SubagentValue {
  readonly sessionId: string
  readonly text: string
  /** Present when the caller asked for an outputSchema and the child reported in it. */
  readonly structured?: { readonly value: unknown }
}

/**
 * Runs one task in a child agent and answers with what it said. The child owns
 * its own session, so its work stays in the log next to the parent's.
 */
export interface SubagentHost {
  readonly agents: AgentsShape
  readonly route: string
  /**
   * The routes this run lets a child take, as the run's model settings name
   * them. A host without the list checks only the shape, because it has
   * nothing to offer the model.
   */
  readonly routes?: ReadonlyArray<string>
  /**
   * The agent presets this host offers children: `allowed` names what the
   * model may ask for, and `default` is what it gets when it asks for nothing.
   * A host without presets refuses the argument, so a profile that names none
   * changes no child.
   */
  readonly presets?: {
    readonly allowed: ReadonlyArray<string>
    readonly default?: string
  }
  /**
   * Where a child's structured report is kept between the call that asks for it
   * and the answer the parent reads. A host without it refuses outputSchema.
   */
  readonly outputs?: StructuredOutputs
  /**
   * How deep delegation may go. A function reads the run's current setting, so the
   * call after a change sees it; absent keeps the default.
   */
  readonly maxDepth?: DepthLimit
}

/** The preset a child runs under: the allowed one it was given, or the host's default. */
const presetFor = (
  asked: string | undefined,
  presets: SubagentHost['presets'],
): string | undefined | ToolError => {
  if (asked === undefined) return presets?.default
  if (presets === undefined || !presets.allowed.includes(asked)) {
    return new ToolError({
      code: 'invalid-arguments',
      message: 'not an allowed agent preset: ' + asked,
    })
  }
  return asked
}

/** Starts the child the arguments describe, with the route and preset already checked. */
const startChild = (
  agents: AgentsShape,
  args: SubagentArgs,
  context: { readonly sessionId: string; readonly cwd: string },
  route: string,
  preset: string | undefined,
): Effect.Effect<Agent, ToolError> =>
  agents
    .create({
      cwd: args.cwd ?? context.cwd,
      options: { route, ...(preset === undefined ? {} : { preset }) },
      seed: args.context === 'fresh' ? [] : forkSeed(eventsOfAgent(agents, context.sessionId)),
      parent: context.sessionId,
    })
    .pipe(
      Effect.mapError(
        () => new ToolError({ code: 'execution', message: 'cannot start a child agent' }),
      ),
    )

/** Refuses a structured request this host cannot honour before a child starts. */
const structuredRefusal = (
  args: SubagentArgs,
  outputs: StructuredOutputs | undefined,
): ToolError | undefined => {
  if (args.outputSchema === undefined) return undefined
  if (outputs === undefined) {
    return new ToolError({
      code: 'execution',
      message: 'this host cannot take a structured report',
    })
  }
  if (args.task === undefined) {
    return new ToolError({
      code: 'invalid-arguments',
      message: 'an outputSchema needs a task, because an idle child has nothing to report',
    })
  }
  return undefined
}

/** The task the child reads, with the shape it owes spelled out when one was asked for. */
const taskFor = (task: string, schema: Schema.JsonObject | undefined): string =>
  schema === undefined
    ? task
    : task +
      '\n\nWhen the task is done, call structured_output with a value that matches this JSON Schema:\n' +
      JSON.stringify(schema)

/** Sets the schema on the child's slot when the caller asked for one. */
const expectReport = (
  outputs: StructuredOutputs | undefined,
  schema: Schema.JsonObject | undefined,
  childId: string,
): ToolError | undefined => {
  if (outputs === undefined || schema === undefined) return undefined
  return outputs.expect(childId, schema)
}

/** Runs the task and turns what the child reported into the value the parent reads. */
const runTask = (
  child: Agent,
  task: string,
  schema: Schema.JsonObject | undefined,
  outputs: StructuredOutputs | undefined,
): Effect.Effect<SubagentValue, ToolError> =>
  Effect.gen(function* () {
    yield* child
      .followup({ text: taskFor(task, schema), source: 'user' })
      .pipe(
        Effect.mapError(
          () => new ToolError({ code: 'execution', message: 'the child agent took no message' }),
        ),
      )
    yield* child.whenIdle
    const text = childAnswerOf(child)
    if (schema === undefined) return { sessionId: child.id, text }
    const report = outputs?.take(child.id)
    if (report !== undefined) return { sessionId: child.id, text, structured: report }
    return yield* Effect.fail(
      new ToolError({
        code: 'execution',
        message:
          'the child finished without a structured report: ' +
          child.id +
          (text === '' ? '' : ' (it said: ' + text + ')'),
      }),
    )
  })

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
      schema: Schema.Struct({
        sessionId: Schema.String,
        text: Schema.String,
        structured: Schema.optionalKey(Schema.Struct({ value: Schema.Unknown })),
      }),
      // The session id rides along, so the parent can send the child more work or wait for it.
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.text === ''
              ? '(the child is idle; send it work with send_message)'
              : value.text) +
            (value.structured === undefined
              ? ''
              : '\n\n[structured report: ' + JSON.stringify(value.structured.value) + ']') +
            '\n\n[child session: ' +
            value.sessionId +
            ']',
        },
      ],
    },
    execute: (args, context) =>
      Effect.gen(function* () {
        const refused = delegationRefusal(
          agents,
          context.sessionId,
          host.maxDepth ?? DELEGATION_MAX_DEPTH,
        )
        if (refused !== undefined) return yield* Effect.fail(refused)
        const route = routeFor(args.model, host.route, host.routes)
        if (route instanceof ToolError) return yield* Effect.fail(route)
        const preset = presetFor(args.preset, host.presets)
        if (preset instanceof ToolError) return yield* Effect.fail(preset)
        const outputs = host.outputs
        const unhonoured = structuredRefusal(args, outputs)
        if (unhonoured !== undefined) return yield* Effect.fail(unhonoured)
        const child = yield* startChild(agents, args, context, route, preset)
        const refusedReport = expectReport(outputs, args.outputSchema, child.id)
        if (refusedReport !== undefined) return yield* Effect.fail(refusedReport)
        if (args.task === undefined) return { sessionId: child.id, text: '' }
        return yield* runTask(child, args.task, args.outputSchema, outputs)
      }),
  }
}
