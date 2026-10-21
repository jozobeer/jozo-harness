import { Effect, Schema } from 'effect'
import { fromJsonSchemaDocument } from 'effect/SchemaRepresentation'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

/** A report a child owes its parent, with the schema compiled once when the parent asks. */
interface PendingReport {
  readonly schema: Schema.Top
  readonly value?: unknown
  readonly reported: boolean
}

/** What a child reported through structured_output. */
export interface StructuredReport {
  readonly value: unknown
}

/**
 * The reports children owe their parents, one slot per child session.
 *
 * The tool registry is shared by every agent in one run, so the schema cannot
 * live in the tool declaration. Keying the slots by session keeps children that
 * run side by side from reading or overwriting each other's schema.
 */
export interface StructuredOutputs {
  /** Sets the schema a session's next structured_output must match. */
  expect(sessionId: string, schema: Schema.JsonObject): ToolError | undefined
  /** Checks a report against the session's schema and, when it matches, keeps it. */
  report(sessionId: string, value: unknown): ToolError | undefined
  /** The kept report, removed so only the parent that asked can read it once. */
  take(sessionId: string): StructuredReport | undefined
}

const compile = (schema: Schema.JsonObject): Schema.Top | ToolError => {
  try {
    return fromJsonSchemaDocument({ dialect: 'draft-2020-12', schema, definitions: {} })
  } catch (cause) {
    return new ToolError({
      code: 'invalid-arguments',
      message:
        'cannot read the output schema: ' +
        (cause instanceof Error ? cause.message : String(cause)),
    })
  }
}

export const makeStructuredOutputs = (): StructuredOutputs => {
  const pending = new Map<string, PendingReport>()
  return {
    expect: (sessionId, schema) => {
      const compiled = compile(schema)
      if (compiled instanceof ToolError) return compiled
      pending.set(sessionId, { schema: compiled, reported: false })
      return undefined
    },
    report: (sessionId, value) => {
      const slot = pending.get(sessionId)
      if (slot === undefined) {
        return new ToolError({
          code: 'invalid-arguments',
          message: 'no output schema was asked of this session: ' + sessionId,
        })
      }
      if (!Schema.is(slot.schema)(value)) {
        return new ToolError({
          code: 'invalid-arguments',
          message: 'the report does not match the output schema the parent asked for',
        })
      }
      pending.set(sessionId, { schema: slot.schema, value, reported: true })
      return undefined
    },
    take: (sessionId) => {
      const slot = pending.get(sessionId)
      pending.delete(sessionId)
      return slot?.reported === true ? { value: slot.value } : undefined
    },
  }
}

const Parameters = Schema.Struct({
  value: Schema.Json.annotate({
    description: 'The answer, as a JSON value that matches the schema the parent described.',
  }),
})

export type StructuredOutputArgs = Schema.Schema.Type<typeof Parameters>

/**
 * Reports the final answer in the shape the parent asked for. A value that does
 * not match is refused, so the child can try again in the same turn; a matching
 * one ends the turn because there is nothing left to add.
 */
export const makeStructuredOutputTool = (
  outputs: StructuredOutputs,
): ToolDefinition<StructuredOutputArgs, { readonly accepted: true }> => ({
  name: 'structured_output',
  description:
    'Reports the final answer in the shape the parent asked for. Call it once the task is done; a value that does not match the given schema is refused, and you can report again.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({ accepted: Schema.Literal(true) }),
    render: () => [{ type: 'text', text: 'the report was accepted' }],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const refusal = outputs.report(context.sessionId, args.value)
      if (refusal !== undefined) return yield* Effect.fail(refusal)
      context.concludeTurn?.()
      return { accepted: true as const }
    }),
})
