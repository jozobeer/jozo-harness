import { HooksLive } from '@jozo-harness/kernel'
import { makeAsk, type AskAnswer } from '@jozo-harness/safety'
import { Tools, toolsLayer, type ToolExecutionResult } from '@jozo-harness/tools'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
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

const batch = [
  {
    id: 'colour',
    question: 'which colour?',
    header: 'Colour',
    options: ['blue', 'red'],
  },
  {
    id: 'toppings',
    question: 'which toppings?',
    options: ['cheese', 'olives'],
    multi_select: true,
  },
]

const answers: ReadonlyArray<AskAnswer> = [
  { id: 'colour', selected: ['blue'] },
  { id: 'toppings', selected: ['cheese', 'olives'], custom: 'no anchovies' },
]

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

  test('asks every question in one call and keeps multi-select and custom answers', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ask = yield* makeAsk()
          yield* ask.serveBatch(() => Effect.succeed(answers))
          const tools = yield* Tools
          yield* tools.register(askUserToolFor(ask))
          const result = yield* call('c4', { questions: batch })
          return { value: result.value, content: result.content, isError: result.isError }
        }).pipe(Effect.provide(Layer.provideMerge(toolsLayer, HooksLive))),
      ),
    )

    expect(observed.isError).toBe(false)
    expect(observed.value).toEqual({ callId: 'c4', answers })
    expect(JSON.stringify(observed.content)).toContain('no anchovies')
  })

  test('refuses a repeated question id before anybody is asked', async () => {
    let asked = 0
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ask = yield* makeAsk()
          yield* ask.serveBatch(() =>
            Effect.sync(() => {
              asked += 1
              return answers
            }),
          )
          const tools = yield* Tools
          yield* tools.register(askUserToolFor(ask))
          return yield* call('c5', {
            questions: [
              { id: 'same', question: 'first?' },
              { id: 'same', question: 'second?' },
            ],
          })
        }).pipe(Effect.provide(Layer.provideMerge(toolsLayer, HooksLive))),
      ),
    )

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('must be unique')
    expect(asked).toBe(0)
  })

  test('a time limit returns the unanswered questions as pending', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ask = yield* makeAsk()
          const gate = yield* Deferred.make<ReadonlyArray<AskAnswer>>()
          yield* ask.serveBatch(() => Deferred.await(gate))
          const tools = yield* Tools
          yield* tools.register(askUserToolFor(ask))
          const fiber = yield* call('c6', {
            questions: batch,
            time_limit_ms: 1000,
          }).pipe(Effect.forkChild)
          yield* TestClock.adjust('1 second')
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(Layer.provideMerge(toolsLayer, HooksLive)),
          Effect.provide(TestClock.layer()),
        ),
      ),
    )

    expect(observed.isError).toBe(false)
    expect(observed.value).toEqual({
      callId: 'c6',
      pending: true,
      unanswered: ['colour', 'toppings'],
    })
    expect(JSON.stringify(observed.content)).toContain('Pending questions')
  })

  test('the single-question form keeps working alongside the batch form', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ask = yield* makeAsk()
          yield* ask.serve(() => Effect.succeed('red'))
          const tools = yield* Tools
          yield* tools.register(askUserToolFor(ask))
          const result = yield* call('c7', { question: 'which colour?', options: ['blue', 'red'] })
          return { value: result.value, isError: result.isError }
        }).pipe(Effect.provide(Layer.provideMerge(toolsLayer, HooksLive))),
      ),
    )

    expect(observed.isError).toBe(false)
    expect(observed.value).toEqual({ id: 'c7', question: 'which colour?', answer: 'red' })
  })
})
