import { HooksLive } from '@jozo-harness/kernel'
import { makeAsk } from '@jozo-harness/safety'
import { Tools, toolsLayer, type ToolExecutionResult } from '@jozo-harness/tools'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { askUserToolFor } from '../src/index.ts'

const call = (callId: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const tools = yield* Tools
    return yield* tools.call({
      callId,
      tool: 'ask_user',
      arguments: JSON.stringify(args),
      context: { sessionId: 's1', cwd: '/tmp', callId },
    })
  })

describe('ask_user tool', () => {
  test('waits for the answer and reports it', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ask = yield* makeAsk()
          yield* ask.serve(() => Effect.succeed('blue'))
          const tools = yield* Tools
          yield* tools.register(askUserToolFor(ask))
          const result: ToolExecutionResult = yield* call('c1', {
            question: 'which colour?',
            options: ['blue', 'red'],
          })
          return { value: result.value, isError: result.isError }
        }).pipe(Effect.provide(Layer.provideMerge(toolsLayer, HooksLive))),
      ),
    )

    expect(observed.isError).toBe(false)
    expect(observed.value).toEqual({ id: 'c1', question: 'which colour?', answer: 'blue' })
  })

  test('a question nobody answers fails at once instead of hanging', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ask = yield* makeAsk()
          const tools = yield* Tools
          yield* tools.register(askUserToolFor(ask))
          return yield* call('c3', { question: 'which colour?' })
        }).pipe(Effect.provide(Layer.provideMerge(toolsLayer, HooksLive))),
      ),
    )

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('nobody is listening')
  })

  test('the answer is what the model sees', async () => {
    const content = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ask = yield* makeAsk()
          yield* ask.serve(() => Effect.succeed('jozo-harness'))
          const tools = yield* Tools
          yield* tools.register(askUserToolFor(ask))
          const result = yield* call('c2', { question: 'name?' })
          return result.content
        }).pipe(Effect.provide(Layer.provideMerge(toolsLayer, HooksLive))),
      ),
    )

    expect(content).toEqual([{ type: 'text', text: 'jozo-harness' }])
  })
})
