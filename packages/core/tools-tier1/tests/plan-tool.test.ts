import { HooksLive } from '@jozo-harness/kernel'
import type { AskRequested, AskShape, PlanModeShape } from '@jozo-harness/safety'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeExitPlanModeTool } from '../src/index.ts'

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'call-7',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd: '/work', callId: 'call-7' },
      })
    }),
  )

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

/** The user answering whatever the tool asked, and a record of the question. */
const answerer = (answer: string, asked: Array<AskRequested>): AskShape =>
  ({
    ask: (request: AskRequested) => {
      asked.push(request)
      return Effect.succeed(answer)
    },
  }) as unknown as AskShape

const planMode = (left: Array<string>): PlanModeShape =>
  ({
    leave: () => {
      left.push('left')
    },
    active: () => left.length === 0,
  }) as unknown as PlanModeShape

describe('exit_plan_mode', () => {
  test('an approval ends plan mode and hands the plan back', async () => {
    const asked: Array<AskRequested> = []
    const left: Array<string> = []

    const result = await Effect.runPromise(
      call(makeExitPlanModeTool(planMode(left), answerer('approve', asked)), {
        plan: '1. read the code\n2. change it',
      }),
    )

    expect(left).toEqual(['left'])
    expect(result?.value).toMatchObject({ left: true })
    // Approval has nothing left to ask the model: the call closes the turn.
    expect(result?.concludesTurn).toBe(true)
    expect(textOf(result)).toContain('plan mode is over')
    expect(textOf(result)).toContain('1. read the code')
    // The question is the call, and the user is offered the two ways out.
    expect(asked[0]?.id).toBe('call-7')
    expect(asked[0]?.options).toEqual(['approve', 'keep planning'])
    expect(asked[0]?.question).toContain('1. read the code')
  })

  test('anything else keeps plan mode and carries the words back', async () => {
    const asked: Array<AskRequested> = []
    const left: Array<string> = []

    const result = await Effect.runPromise(
      call(makeExitPlanModeTool(planMode(left), answerer('change step 2 first', asked)), {
        plan: '1. read the code',
      }),
    )

    expect(left).toEqual([])
    expect(result?.value).toMatchObject({ left: false, answer: 'change step 2 first' })
    expect(result?.concludesTurn).toBeUndefined()
    expect(textOf(result)).toContain('the user kept plan mode: change step 2 first')
  })

  test('approval is read without case or padding mattering', async () => {
    const left: Array<string> = []

    await Effect.runPromise(
      call(makeExitPlanModeTool(planMode(left), answerer(' Approve ', [])), { plan: 'x' }),
    )

    expect(left).toEqual(['left'])
  })
})
