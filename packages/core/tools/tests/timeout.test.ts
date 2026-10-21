import { HooksLive } from '@jozo-harness/kernel'
import { Context, Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { Tools, toolsLayer, type ToolDefinition } from '../src/index.ts'

const makeTool = (
  name: string,
  timeoutMs: number | undefined,
  sleepMs: number,
): ToolDefinition<{}, { readonly ok: boolean }> => ({
  name,
  description: 'Sleeps',
  parameters: Schema.Struct({}),
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
  output: {
    schema: Schema.Struct({ ok: Schema.Boolean }),
    render: () => [{ type: 'text', text: 'ok' }],
  },
  execute: () => Effect.sleep(sleepMs).pipe(Effect.as({ ok: true })),
})

const call = (tool: ToolDefinition<any, any>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'c1',
        tool: tool.name,
        arguments: '{}',
        context: { sessionId: 's1', cwd: '/tmp', callId: 'c1' },
      })
    }),
  )

describe('tool call timeout', () => {
  test('a slow call ends as an error result', async () => {
    const result = await Effect.runPromise(call(makeTool('slow', 10, 200)))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('timed out after')
    expect(result?.error).toEqual({ name: 'TimeoutError', code: 'timeout' })
  })

  test('a call inside its limit succeeds', async () => {
    const result = await Effect.runPromise(call(makeTool('quick', 500, 5)))

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual({ ok: true })
  })

  test('without a limit the call is not timed out', async () => {
    const result = await Effect.runPromise(call(makeTool('patient', undefined, 30)))

    expect(result?.isError).toBe(false)
  })
})
