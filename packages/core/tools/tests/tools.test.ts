import { describe, expect, test } from 'vitest'
import { HooksLive, makeHooks } from '@jozo-harness/kernel'
import { Effect, Exit, Schema, Scope } from 'effect'
import {
  ToolError,
  Tools,
  makeTools,
  toolsLayer,
  type ToolDefinition,
  type ToolRegistry,
  type ToolRunContext,
} from '../src/index.ts'

const context: ToolRunContext = { sessionId: 's-1', cwd: '/work', callId: 'call-1' }

type EchoTool = ToolDefinition<{ readonly text: string }, { readonly text: string }>

const echo: EchoTool = {
  name: 'echo',
  description: 'Echo text back',
  parameters: Schema.Struct({ text: Schema.String }),
  output: {
    schema: Schema.Struct({ text: Schema.String }),
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  execute: (args) => Effect.succeed({ text: args.text }),
  isConcurrencySafe: () => true,
}

const request = (argumentsJson: string) => ({
  callId: context.callId,
  tool: 'echo',
  arguments: argumentsJson,
  context,
})

const scoped = <A>(tools: ToolRegistry, body: () => Effect.Effect<A, never, never>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* tools.register(echo)
        return yield* body()
      }),
    ),
  )

describe('registration', () => {
  test('schemas exposes only the model-facing allowlist', async () => {
    const tools = makeTools(makeHooks())

    const schemas = await scoped(tools, () => Effect.succeed(tools.schemas()))

    expect(schemas).toHaveLength(1)
    expect(schemas[0]?.name).toBe('echo')
    expect(schemas[0]?.description).toBe('Echo text back')
    expect(Object.keys(schemas[0] ?? {})).toEqual(['name', 'description', 'parameters'])
    expect(schemas[0]?.parameters).toMatchObject({ type: 'object' })
  })

  test('a registration disappears when its scope closes', async () => {
    const tools = makeTools(makeHooks())
    await Effect.runPromise(Effect.scoped(tools.register(echo)))

    expect(tools.schemas()).toEqual([])
  })

  test('a retired tool leaves the schemas and still answers a call already chosen', async () => {
    const tools = makeTools(makeHooks())

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(echo)
          tools.retire('echo')
          return {
            offered: tools.schemas().map((schema) => schema.name),
            answered: yield* tools.call(request(JSON.stringify({ text: 'still here' }))),
          }
        }),
      ),
    )

    expect(outcome.offered).toEqual([])
    expect(outcome.answered.isError).toBe(false)
    expect(outcome.answered.value).toEqual({ text: 'still here' })
  })

  test('a scope that closes drops the tool it retired', async () => {
    const tools = makeTools(makeHooks())
    const scope = await Effect.runPromise(Scope.make())

    await Effect.runPromise(Effect.provideService(tools.register(echo), Scope.Scope, scope))
    tools.retire('echo')
    await Effect.runPromise(Scope.close(scope, Exit.void))

    const outcome = await Effect.runPromise(tools.call(request(JSON.stringify({ text: 'gone' }))))
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'unknown-tool' })
  })

  test('duplicate registration fails with duplicate-tool', async () => {
    const tools = makeTools(makeHooks())
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(echo)
          return yield* Effect.flip(tools.register(echo))
        }),
      ),
    )

    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe('duplicate-tool')
  })

  test('restrictions filter the model-facing schemas', async () => {
    const tools = makeTools(makeHooks())
    const schemas = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(echo)
          yield* tools.restrict({ name: 'plan-mode', allows: () => false })
          return tools.schemas()
        }),
      ),
    )

    expect(schemas).toEqual([])
  })
})

describe('call pipeline', () => {
  test('parses arguments, executes, renders content, and emits the result', async () => {
    const hooks = makeHooks()
    const tools = makeTools(hooks)
    const seen: Array<unknown> = []
    const value = crypto.randomUUID()

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('tools/result', (result) => {
            seen.push(result)
          })
          yield* tools.register(echo)
          return yield* tools.call(request(JSON.stringify({ text: value })))
        }),
      ),
    )

    expect(outcome.isError).toBe(false)
    expect(outcome.content).toEqual([{ type: 'text', text: value }])
    expect(outcome.value).toEqual({ text: value })
    expect(seen).toEqual([outcome])
  })

  test('an unknown tool becomes an error outcome', async () => {
    const tools = makeTools(makeHooks())
    const outcome = await Effect.runPromise(
      Effect.scoped(tools.call({ ...request('{}'), tool: 'missing' })),
    )

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('missing')
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'unknown-tool' })
  })

  test('invalid arguments become an error outcome without executing', async () => {
    const tools = makeTools(makeHooks())
    let executed = 0
    const counted: EchoTool = {
      ...echo,
      execute: (args) =>
        Effect.sync(() => {
          executed += 1
          return { text: args.text }
        }),
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(counted)
          return yield* tools.call(request('not json'))
        }),
      ),
    )

    expect(outcome.isError).toBe(true)
    expect(executed).toBe(0)
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'invalid-arguments' })
  })

  test('an argument error names the parameter that is missing', async () => {
    const tools = makeTools(makeHooks())

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(echo)
          return yield* tools.call(request(JSON.stringify({ txt: 'hi' })))
        }),
      ),
    )

    const text = (outcome.content[0] as { readonly text: string }).text
    expect(outcome.isError).toBe(true)
    expect(text).toContain('received arguments that do not match its parameters')
    expect(text).toContain('"text"')
  })

  test('an argument error names the parameter whose type is wrong', async () => {
    const tools = makeTools(makeHooks())

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(echo)
          return yield* tools.call(request(JSON.stringify({ text: 42 })))
        }),
      ),
    )

    const text = (outcome.content[0] as { readonly text: string }).text
    expect(outcome.isError).toBe(true)
    expect(text).toContain('"text"')
    expect(text).toContain('Expected string')
  })

  test('a defect in execute becomes an error outcome', async () => {
    const tools = makeTools(makeHooks())
    const broken: EchoTool = {
      ...echo,
      execute: () =>
        Effect.sync(() => {
          throw new Error('tool exploded')
        }),
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(broken)
          return yield* tools.call(request(JSON.stringify({ text: 'x' })))
        }),
      ),
    )

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('tool exploded')
    expect(outcome.error).toEqual({ name: 'Error', code: 'execution' })
  })

  test('a failed call carries the code of the tool error', async () => {
    const tools = makeTools(makeHooks())
    const broken: EchoTool = {
      ...echo,
      execute: () => Effect.fail(new ToolError({ code: 'execution', message: 'disk is gone' })),
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(broken)
          return yield* tools.call(request(JSON.stringify({ text: 'x' })))
        }),
      ),
    )

    expect(outcome.isError).toBe(true)
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'execution' })
  })
})

describe('turn conclusion', () => {
  test('a tool that concludes the turn marks its successful result', async () => {
    const tools = makeTools(makeHooks())
    const closer: EchoTool = {
      ...echo,
      execute: (args, exec) => {
        exec.concludeTurn?.()
        return Effect.succeed({ text: args.text })
      },
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(closer)
          return yield* tools.call(request(JSON.stringify({ text: 'done' })))
        }),
      ),
    )

    expect(outcome.isError).toBe(false)
    expect(outcome.concludesTurn).toBe(true)
  })

  test('a failing tool never concludes the turn', async () => {
    const tools = makeTools(makeHooks())
    const broken: EchoTool = {
      ...echo,
      execute: (_args, exec) => {
        exec.concludeTurn?.()
        return Effect.fail(new ToolError({ code: 'execution', message: 'broke after concluding' }))
      },
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(broken)
          return yield* tools.call(request(JSON.stringify({ text: 'x' })))
        }),
      ),
    )

    expect(outcome.isError).toBe(true)
    expect(outcome.concludesTurn).toBeUndefined()
  })
})

describe('policy', () => {
  test('a pre-execute deny blocks execution and still emits the result', async () => {
    const hooks = makeHooks()
    const tools = makeTools(hooks)
    let executed = 0
    const seen: Array<unknown> = []

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('tools/result', (result) => {
            seen.push(result)
          })
          yield* hooks.on('tools/pre-execute', () =>
            Effect.succeed({ kind: 'deny' as const, reason: 'policy says no' }),
          )
          yield* tools.register({
            ...echo,
            execute: () =>
              Effect.sync(() => {
                executed += 1
                return { text: 'x' }
              }),
          })
          return yield* tools.call(request(JSON.stringify({ text: 'x' })))
        }),
      ),
    )

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('policy says no')
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'denied', reason: 'policy says no' })
    expect(executed).toBe(0)
    expect(seen).toEqual([outcome])
  })

  test('ask is denied while no approval service is installed', async () => {
    const hooks = makeHooks()
    const tools = makeTools(hooks)
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('tools/pre-execute', () =>
            Effect.succeed({ kind: 'ask' as const, reason: 'needs a human' }),
          )
          yield* tools.register(echo)
          return yield* tools.call(request(JSON.stringify({ text: 'x' })))
        }),
      ),
    )

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('needs a human')
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'denied', reason: 'needs a human' })
  })

  test('a guard cannot be bypassed by a prepended allow', async () => {
    const hooks = makeHooks()
    const tools = makeTools(hooks)
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('tools/pre-execute', () => Effect.succeed({ kind: 'allow' as const }), {
            prepend: true,
          })
          yield* tools.guard({
            name: 'no-echo',
            check: () => Effect.succeed({ kind: 'deny' as const, reason: 'guarded' }),
          })
          yield* tools.register(echo)
          return yield* tools.call(request(JSON.stringify({ text: 'x' })))
        }),
      ),
    )

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('guarded')
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'denied', reason: 'guarded' })
  })

  test('an abstaining guard lets execution continue', async () => {
    const hooks = makeHooks()
    const tools = makeTools(hooks)
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.guard({
            name: 'abstain',
            check: () => Effect.succeed({ kind: 'abstain' as const }),
          })
          yield* tools.register(echo)
          return yield* tools.call(request(JSON.stringify({ text: 'ok' })))
        }),
      ),
    )

    expect(outcome.isError).toBe(false)
  })
})

describe('result shaping', () => {
  test('post-execute replaces the result', async () => {
    const hooks = makeHooks()
    const tools = makeTools(hooks)
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* hooks.on('tools/post-execute', () =>
            Effect.succeed({
              isError: false,
              content: [{ type: 'text' as const, text: 'replaced' }],
            }),
          )
          yield* tools.register(echo)
          return yield* tools.call(request(JSON.stringify({ text: 'original' })))
        }),
      ),
    )

    expect(outcome.content).toEqual([{ type: 'text', text: 'replaced' }])
  })

  test('finalizeContent replaces the rendered content', async () => {
    const tools = makeTools(makeHooks())
    const finalized: EchoTool = {
      ...echo,
      finalizeContent: () => [{ type: 'text', text: 'finalized' }],
    }

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(finalized)
          return yield* tools.call(request(JSON.stringify({ text: 'original' })))
        }),
      ),
    )

    expect(outcome.content).toEqual([{ type: 'text', text: 'finalized' }])
  })

  test('presentCall and presentResult use the tool views', async () => {
    const tools = makeTools(makeHooks())
    const custom: EchoTool = {
      ...echo,
      presentCall: (args) => ({ summary: `echo ${args.text}` }),
      presentResult: (_args, result) => ({ ...result, summary: 'done' }),
    }

    const view = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(custom)
          return {
            call: tools.presentCall('echo', JSON.stringify({ text: 'hi' })),
            result: tools.presentResult('echo', JSON.stringify({ text: 'hi' }), {
              isError: false,
              summary: 'raw',
            }),
          }
        }),
      ),
    )

    expect(view.call.summary).toBe('echo hi')
    expect(view.result.summary).toBe('done')
  })

  test('isConcurrencySafe reads the tool definition', async () => {
    const tools = makeTools(makeHooks())
    const safe = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* tools.register(echo)
          return tools.isConcurrencySafe('echo', JSON.stringify({ text: 'x' }))
        }),
      ),
    )

    expect(safe).toBe(true)
    expect(tools.isConcurrencySafe('missing', '{}')).toBe(false)
  })
})

describe('Tools service', () => {
  test('is available through the context', async () => {
    const schemas = await Effect.runPromise(
      Effect.gen(function* () {
        const tools = yield* Tools
        return tools.schemas()
      }).pipe(Effect.provide(toolsLayer), Effect.provide(HooksLive)),
    )

    expect(schemas).toEqual([])
  })
})
