import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeStructuredOutputs, makeStructuredOutputTool } from '../src/index.ts'

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
  sessionId = 'child-1',
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'call-1',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId, cwd: '/work', callId: 'call-1' },
      })
    }),
  )

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

const reportSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    score: { type: 'integer' },
  },
  required: ['summary'],
  additionalProperties: false,
} as const

describe('structured_output tool', () => {
  test('takes a report that matches the schema and ends the turn', async () => {
    const outputs = makeStructuredOutputs()
    const tool = makeStructuredOutputTool(outputs)
    expect(outputs.expect('child-1', reportSchema)).toBeUndefined()

    const result = await Effect.runPromise(call(tool, { value: { summary: 'done', score: 3 } }))

    expect(result?.isError).toBe(false)
    expect(result?.concludesTurn).toBe(true)
    expect(outputs.take('child-1')).toEqual({ value: { summary: 'done', score: 3 } })
  })

  test('refuses a report that does not match the schema', async () => {
    const outputs = makeStructuredOutputs()
    const tool = makeStructuredOutputTool(outputs)
    outputs.expect('child-1', reportSchema)

    const result = await Effect.runPromise(call(tool, { value: { summary: 7 } }))

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('does not match')
    expect(outputs.take('child-1')).toBeUndefined()
  })

  test('refuses a session the parent asked for no report from', async () => {
    const outputs = makeStructuredOutputs()
    const tool = makeStructuredOutputTool(outputs)

    const result = await Effect.runPromise(call(tool, { value: { summary: 'done' } }, 'other'))

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('no output schema')
  })

  test('keeps reports of sessions that run side by side apart', async () => {
    const outputs = makeStructuredOutputs()
    const tool = makeStructuredOutputTool(outputs)
    outputs.expect('a', {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })
    outputs.expect('b', {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    })

    await Effect.runPromise(call(tool, { value: { name: 'a' } }, 'a'))
    const wrong = await Effect.runPromise(call(tool, { value: { name: 'b' } }, 'b'))

    expect(wrong?.isError).toBe(true)
    expect(outputs.take('a')).toEqual({ value: { name: 'a' } })
    expect(outputs.take('b')).toBeUndefined()
  })

  test('refuses a schema it cannot read', () => {
    const outputs = makeStructuredOutputs()

    // Patterns are refused by default, so the parent learns now instead of the child later.
    const refusal = outputs.expect('child-1', {
      type: 'object',
      properties: { name: { type: 'string', pattern: '^a+$' } },
    })

    expect(refusal?.message).toContain('cannot read the output schema')
  })
})
