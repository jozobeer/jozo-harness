import { Effect, Schema } from 'effect'
import type { AskRequested, AskShape } from '@jozo-harness/safety'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const Parameters = Schema.Struct({
  question: Schema.String.annotate({
    description: 'The one question only the human can answer.',
  }),
  options: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: 'Choices to offer, when the answer is one of a few.',
    }),
  ),
})

export type AskArgs = Schema.Schema.Type<typeof Parameters>

export interface AskValue {
  readonly id: string
  readonly question: string
  readonly answer: string
}

/** Asks one question; a question nobody can answer fails the call rather than hanging it. */
export const askOrFail = (ask: AskShape, request: AskRequested): Effect.Effect<string, ToolError> =>
  ask
    .ask(request)
    .pipe(Effect.mapError((error) => new ToolError({ code: 'execution', message: error.message })))

/**
 * Asks the user one question and waits for the answer. The question id is the
 * call id, so the request and the answer line up in the log.
 */
export const askUserToolFor = (ask: AskShape): ToolDefinition<AskArgs, AskValue> => ({
  name: 'ask_user',
  description:
    'Asks the user one question and waits for the answer. Use it when only the human can decide; do not guess at their choice.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({ id: Schema.String, question: Schema.String, answer: Schema.String }),
    render: (_args, value) => [{ type: 'text', text: value.answer }],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const answer = yield* askOrFail(ask, {
        id: context.callId,
        question: args.question,
        options: args.options ?? [],
      })
      return { id: context.callId, question: args.question, answer }
    }),
})

/** The default ask tool, using whatever holder the caller passes. */
export const makeAskUserTool = askUserToolFor
