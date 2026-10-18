import type { HookRegistry } from '@jozo-harness/kernel'
import { Cause, Effect, Option, Schema, SchemaIssue, Duration } from 'effect'
import {
  ToolError,
  type PreExecuteDecision,
  type ToolCallOutcome,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolExecution,
  type ToolExecutionResult,
  type ToolGuard,
} from './types.ts'

type AnyTool = ToolDefinition<any, any>

export const errorResult = (message: string): ToolExecutionResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
})

const describeCause = (cause: Cause.Cause<unknown>): string => {
  const first = Cause.prettyErrors(cause)[0]
  return first?.message ?? 'tool execution failed'
}

const formatViolations = SchemaIssue.makeFormatterStandardSchemaV1()

/** Names each parameter that failed, so a model can correct the call in one step. */
const describeViolations = (issue: SchemaIssue.Issue): string =>
  formatViolations(issue)
    .issues.map((violation) =>
      violation.path === undefined || violation.path.length === 0
        ? violation.message
        : `${violation.message} at ${JSON.stringify(violation.path)}`,
    )
    .join('; ')

/** Decodes raw argument JSON without running an Effect, for views and concurrency checks. */
const invalidArguments = (tool: AnyTool, detail?: string): ToolError =>
  new ToolError({
    code: 'invalid-arguments',
    message:
      detail === undefined
        ? `${tool.name} received arguments that do not match its parameters`
        : `${tool.name} received arguments that do not match its parameters: ${detail}`,
  })

const parseArguments = (tool: AnyTool, raw: string): Effect.Effect<unknown, ToolError> =>
  Effect.gen(function* () {
    const input = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => invalidArguments(tool),
    })
    return yield* Schema.decodeUnknownEffect(tool.parameters)(input).pipe(
      Effect.mapError((error: Schema.SchemaError) =>
        invalidArguments(tool, describeViolations(error.issue)),
      ),
    ) as Effect.Effect<unknown, ToolError, never>
  })

/**
 * Decodes raw argument JSON synchronously for views and concurrency checks.
 * Tool parameter schemas are pure, so the decode needs no services and cannot
 * suspend.
 */
export const tryDecodeArguments = (tool: AnyTool, raw: string): Option.Option<unknown> =>
  Effect.runSync(
    Effect.match(parseArguments(tool, raw), {
      onFailure: () => Option.none(),
      onSuccess: (args) => Option.some(args),
    }),
  )

const runBody = (tool: AnyTool, exec: ToolExecution): Effect.Effect<ToolExecutionResult> =>
  (tool.timeoutMs === undefined
    ? tool.execute(exec.args, exec.context)
    : Effect.timeout(tool.execute(exec.args, exec.context), Duration.millis(tool.timeoutMs))
  ).pipe(
    Effect.map((value) => ({
      isError: false,
      content: tool.output.render(exec.args, value),
      value,
    })),
    Effect.catchCause((cause) => Effect.succeed(errorResult(describeCause(cause)))),
  )

/**
 * Runs the `tools/execute` waterfall around the tool body. The body is a
 * listener for this call only, so around-plugins can wrap it with `next()`.
 */
const runWithBody = (
  hooks: HookRegistry,
  tool: AnyTool,
  exec: ToolExecution,
): Effect.Effect<ToolExecutionResult> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* hooks.on('tools/execute', () => runBody(tool, exec))
      const decided = yield* hooks.waterfall('tools/execute', exec)
      return decided ?? (yield* runBody(tool, exec))
    }),
  )

const checkPolicy = (
  guards: ReadonlyArray<ToolGuard>,
  exec: ToolExecution,
  decision: PreExecuteDecision | undefined,
): Effect.Effect<ToolExecutionResult | undefined> =>
  Effect.gen(function* () {
    if (decision?.kind === 'deny') return errorResult(`denied: ${decision.reason}`)
    if (decision?.kind === 'ask') return errorResult(`approval required: ${decision.reason}`)
    for (const guard of guards) {
      const guardDecision = yield* guard.check(exec)
      if (guardDecision.kind === 'deny')
        return errorResult(`denied by ${guard.name}: ${guardDecision.reason}`)
    }
    return undefined
  })

const finalize = (
  tool: AnyTool,
  exec: ToolExecution,
  result: ToolExecutionResult,
): ToolExecutionResult => {
  const replacement = tool.finalizeContent?.(exec, result)
  return replacement === undefined ? result : { ...result, content: replacement }
}

/**
 * Runs one call: parse → pre-execute → guards → execute → post-execute →
 * finalize → `tools/result`. Every failure, including a defect, becomes an
 * `isError` result so the loop can continue.
 */
export const executeTool = (
  hooks: HookRegistry,
  tool: AnyTool,
  request: ToolCallRequest,
  guards: ReadonlyArray<ToolGuard>,
): Effect.Effect<ToolCallOutcome> =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const parsed = yield* Effect.match(parseArguments(tool, request.arguments), {
        onFailure: (error: ToolError) => ({ ok: false as const, message: error.message }),
        onSuccess: (args: unknown) => ({ ok: true as const, args }),
      })
      if (!parsed.ok) return errorResult(parsed.message)

      const exec: ToolExecution = {
        callId: request.callId,
        tool: tool.name,
        arguments: request.arguments,
        args: parsed.args,
        context: request.context,
      }

      const policy = yield* checkPolicy(
        guards,
        exec,
        yield* hooks.waterfall('tools/pre-execute', exec),
      )
      if (policy !== undefined) return policy

      const executed = yield* runWithBody(hooks, tool, exec)
      const posted = yield* hooks.waterfall('tools/post-execute', exec, executed)
      return finalize(tool, exec, posted ?? executed)
    }).pipe(Effect.catchCause((cause) => Effect.succeed(errorResult(describeCause(cause)))))

    yield* hooks.emit('tools/result', result)
    return result
  })
