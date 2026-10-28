import { Effect, Schema } from 'effect'
import type {
  AskAnswer,
  AskBatchOutcome,
  AskQuestion,
  AskRequested,
  AskShape,
} from '@jozo-harness/safety'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const Question = Schema.Struct({
  id: Schema.String.annotate({
    description: 'Stable id for this question, unique within the call and echoed in its answer.',
  }),
  question: Schema.String.annotate({
    description: 'The specific question to ask the human.',
  }),
  header: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Optional short heading, such as "Confirm" or "Choose Mode".',
    }),
  ),
  options: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: 'Choices to offer, when the answer is one of a few.',
    }),
  ),
  multi_select: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: 'Whether the human may select more than one option. Defaults to false.',
    }),
  ),
})

const Parameters = Schema.Struct({
  // The single-question form stays for existing callers; a call must pass one form or the other.
  question: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The one question only the human can answer. Use questions to ask several.',
    }),
  ),
  options: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: 'Choices for the single question form, when the answer is one of a few.',
    }),
  ),
  questions: Schema.optionalKey(
    Schema.Array(Question).annotate({
      description: 'Questions to ask before continuing. Each id is unique within this call.',
    }),
  ),
  time_limit_ms: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        'How long to wait for the whole batch. After it, unanswered questions return pending and can still be answered later.',
    }).check(Schema.isGreaterThanOrEqualTo(1)),
  ),
})

export type AskArgs = Schema.Schema.Type<typeof Parameters>

const AskAnswerSchema = Schema.Struct({
  id: Schema.String,
  selected: Schema.Array(Schema.String),
  custom: Schema.optionalKey(Schema.String),
})

const LegacyValue = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  answer: Schema.String,
})

const AnsweredValue = Schema.Struct({
  callId: Schema.String,
  answers: Schema.Array(AskAnswerSchema),
})

const PendingValue = Schema.Struct({
  callId: Schema.String,
  pending: Schema.Literal(true),
  unanswered: Schema.Array(Schema.String),
})

/** The single-question value, the batch value, or the batch that outlived its wait. */
export type AskValue =
  | { readonly id: string; readonly question: string; readonly answer: string }
  | { readonly callId: string; readonly answers: ReadonlyArray<AskAnswer> }
  | { readonly callId: string; readonly pending: true; readonly unanswered: ReadonlyArray<string> }

const textOf = (answer: AskAnswer): string => {
  const parts = [...answer.selected]
  if (answer.custom !== undefined && answer.custom !== '') parts.push(answer.custom)
  return answer.id + ': ' + (parts.length === 0 ? '(skipped)' : parts.join(', '))
}

const render = (
  value: AskValue,
): ReadonlyArray<{ readonly type: 'text'; readonly text: string }> => {
  if ('answer' in value) return [{ type: 'text', text: value.answer }]
  if ('pending' in value) {
    return [
      {
        type: 'text',
        text:
          'Pending questions: ' +
          value.unanswered.join(', ') +
          '. Continue with independent work; any answer will arrive as a user message naming this call (' +
          value.callId +
          ') and its question ids.',
      },
    ]
  }
  return [{ type: 'text', text: value.answers.map(textOf).join('\n') }]
}

const invalid = (message: string): ToolError =>
  new ToolError({ code: 'invalid-arguments', message })

/** The repeated or empty id, or undefined when every id is usable. */
const repeatedIdOf = (questions: NonNullable<AskArgs['questions']>): string | undefined => {
  const ids = new Set<string>()
  for (const question of questions) {
    if (question.id === '' || ids.has(question.id)) return question.id
    ids.add(question.id)
  }
  return undefined
}

const questionsOf = (
  questions: NonNullable<AskArgs['questions']>,
): Effect.Effect<ReadonlyArray<AskQuestion>, ToolError> =>
  Effect.gen(function* () {
    if (questions.length === 0) {
      return yield* Effect.fail(invalid('questions must not be empty'))
    }
    const repeated = repeatedIdOf(questions)
    if (repeated !== undefined) {
      return yield* Effect.fail(
        invalid(
          repeated === ''
            ? 'every question needs a non-empty id'
            : 'question id "' + repeated + '" must be unique within one ask_user call',
        ),
      )
    }
    return questions.map((question) => ({
      id: question.id,
      question: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      options: (question.options ?? []).map((label) => ({ label })),
      multiSelect: question.multi_select ?? false,
    }))
  })

type AskInput =
  | { readonly kind: 'single'; readonly question: string; readonly options: ReadonlyArray<string> }
  | { readonly kind: 'batch'; readonly questions: ReadonlyArray<AskQuestion> }

/** Reads the one form the call passed; mixing both is a mistake rather than a preference. */
const inputOf = (args: AskArgs): Effect.Effect<AskInput, ToolError> =>
  Effect.gen(function* () {
    if (args.questions !== undefined) {
      if (args.question !== undefined) {
        return yield* Effect.fail(invalid('pass questions or question, not both'))
      }
      return { kind: 'batch', questions: yield* questionsOf(args.questions) }
    }
    if (args.question === undefined) {
      return yield* Effect.fail(
        invalid('pass questions, or a question for the single-question form'),
      )
    }
    return { kind: 'single', question: args.question, options: args.options ?? [] }
  })

/** Asks one question; a question nobody can answer fails the call rather than hanging it. */
export const askOrFail = (ask: AskShape, request: AskRequested): Effect.Effect<string, ToolError> =>
  ask
    .ask(request)
    .pipe(Effect.mapError((error) => new ToolError({ code: 'execution', message: error.message })))

const askBatchOrFail = (
  ask: AskShape,
  request: { readonly callId: string; readonly questions: ReadonlyArray<AskQuestion> },
  timeLimitMs: number | undefined,
): Effect.Effect<AskBatchOutcome, ToolError> =>
  ask
    .askBatch(request, timeLimitMs)
    .pipe(Effect.mapError((error) => new ToolError({ code: 'execution', message: error.message })))

/**
 * Asks one or more questions. A call that passes the single question keeps the
 * one-answer result older logs and UIs read; the batch form keeps every answer
 * separate and, with a time limit, reports what is still pending.
 */
export const askUserToolFor = (
  ask: AskShape,
  defaultTimeLimitMs?: number,
): ToolDefinition<AskArgs, AskValue> => ({
  name: 'ask_user',
  description:
    'Asks the human one or more questions and waits for the answers. Use questions to ask several at once, each with a distinct id. With questions and time_limit_ms, unanswered questions come back pending and any later answer arrives as a user message.',
  parameters: Parameters,
  output: {
    schema: Schema.Union([LegacyValue, AnsweredValue, PendingValue]),
    render: (_args, value) => render(value),
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const input = yield* inputOf(args)
      if (input.kind === 'single') {
        const answer = yield* askOrFail(ask, {
          id: context.callId,
          question: input.question,
          options: input.options,
        })
        return { id: context.callId, question: input.question, answer }
      }
      const result = yield* askBatchOrFail(
        ask,
        { callId: context.callId, questions: input.questions },
        args.time_limit_ms ?? defaultTimeLimitMs,
      )
      return result._tag === 'answered'
        ? { callId: context.callId, answers: result.answers }
        : {
            callId: context.callId,
            pending: true as const,
            unanswered: result.unanswered,
          }
    }),
})

/** The default ask tool, using whatever holder the caller passes. */
export const makeAskUserTool = askUserToolFor
