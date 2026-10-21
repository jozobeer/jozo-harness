import { Schema, Effect } from 'effect'
import { PLAN_APPROVAL, type AskShape, type PlanModeShape } from '@jozo-harness/safety'
import type { ToolDefinition } from '@jozo-harness/tools'
import { askOrFail } from './ask.ts'

const Parameters = Schema.Struct({
  plan: Schema.String.annotate({
    description: 'The plan to execute, written out in full as the user should read it.',
  }),
})

export type ExitPlanArgs = Schema.Schema.Type<typeof Parameters>

export interface ExitPlanValue {
  /** Whether the user let plan mode end. */
  readonly left: boolean
  readonly plan: string
  /** What the user answered, verbatim. */
  readonly answer: string
}

/** The two ways out the user is offered; the first one is approval. */
export const EXIT_PLAN_OPTIONS: ReadonlyArray<string> = [PLAN_APPROVAL, 'keep planning']

/**
 * Offers the finished plan to the user: approval ends plan mode, and anything
 * else is read as a reason to keep planning, in the user's own words.
 */
export const makeExitPlanModeTool = (
  planMode: PlanModeShape,
  ask: AskShape,
): ToolDefinition<ExitPlanArgs, ExitPlanValue> => ({
  name: 'exit_plan_mode',
  description:
    'Offers the finished plan to the user. On approval plan mode ends and the tools that change the workspace come back; any other answer says what to change, and the plan stays in plan mode.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({ left: Schema.Boolean, plan: Schema.String, answer: Schema.String }),
    render: (_args, value) => [
      {
        type: 'text',
        text: value.left
          ? 'plan approved; plan mode is over:\n\n' + value.plan
          : 'the user kept plan mode: ' + value.answer,
      },
    ],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const answer = yield* askOrFail(ask, {
        id: context.callId,
        question: 'Leave plan mode and execute this plan?\n\n' + args.plan,
        options: EXIT_PLAN_OPTIONS,
      })
      if (answer.trim().toLowerCase() !== PLAN_APPROVAL) {
        return { left: false, plan: args.plan, answer }
      }
      planMode.leave()
      // The turn carries on: the approval only changes which tools the next
      // request may name, and the model has the plan to work from already.
      return { left: true, plan: args.plan, answer }
    }),
})
