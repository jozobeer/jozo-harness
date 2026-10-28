import { describe, expect, test } from 'vitest'
import { HooksLive } from '@jozo-harness/kernel'
import { Tools, toolsLayer } from '@jozo-harness/tools'
import { Effect, Schema } from 'effect'
import {
  PromptError,
  SystemPrompt,
  builtinSections,
  makeSystemPrompt,
  systemPromptLayer,
  type AssembleContext,
  type PromptSection,
} from '../src/index.ts'

const context: AssembleContext = { variables: {} }

const renderScoped = (sections: ReadonlyArray<PromptSection>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const prompt = makeSystemPrompt()
        for (const section of sections) yield* prompt.section(section)
        return yield* prompt.render(context)
      }),
    ),
  )

describe('section order', () => {
  test('renders by ascending order and then by name code-unit', async () => {
    const text = await renderScoped([
      { name: 'b', order: 1, text: 'B' },
      { name: 'a', order: 1, text: 'A' },
      { name: 'first', order: 0, text: 'FIRST' },
    ])

    expect(text).toBe('FIRST\n\nA\n\nB')
  })

  test('a complete section replaces every other section', async () => {
    const text = await renderScoped([
      { name: 'a', order: 0, text: 'ignored' },
      { name: 'full', order: 99, text: 'ONLY', complete: true },
    ])

    expect(text).toBe('ONLY')
  })

  test('two complete sections cannot be assembled', async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          yield* prompt.section({ name: 'one', order: 0, text: 'ONE', complete: true })
          yield* prompt.section({ name: 'two', order: 0, text: 'TWO', complete: true })
          return yield* Effect.flip(prompt.render(context))
        }),
      ),
    )

    expect(error).toBeInstanceOf(PromptError)
    expect(error.code).toBe('multiple-complete')
  })
})

describe('registration', () => {
  test('a duplicate name fails with duplicate-section', async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          yield* prompt.section({ name: 'a', order: 0, text: 'A' })
          return yield* Effect.flip(prompt.section({ name: 'a', order: 1, text: 'A again' }))
        }),
      ),
    )

    expect(error.code).toBe('duplicate-section')
  })

  test('a section disappears when its scope closes', async () => {
    const prompt = makeSystemPrompt()
    await Effect.runPromise(Effect.scoped(prompt.section({ name: 'a', order: 0, text: 'A' })))

    expect(await Effect.runPromise(prompt.render(context))).toBe('')
    expect(prompt.sections()).toEqual([])
  })
})

describe('text', () => {
  test('a function section receives the assemble context', async () => {
    const value = crypto.randomUUID()
    const contextWithVariables: AssembleContext = { variables: { name: value } }
    const text = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          yield* prompt.section({
            name: 'greeting',
            order: 0,
            text: (assembleContext) => `hello ${assembleContext.variables.name ?? ''}`,
          })
          return yield* prompt.render(contextWithVariables)
        }),
      ),
    )

    expect(text).toBe(`hello ${value}`)
  })

  test('interpolates variables and fails on an unknown one', async () => {
    const rendered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          yield* prompt.section({ name: 'a', order: 0, text: 'cwd={{cwd}}' })
          return yield* prompt.render({ variables: { cwd: '/work' } })
        }),
      ),
    )
    expect(rendered).toBe('cwd=/work')

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          yield* prompt.section({ name: 'a', order: 0, text: '{{missing}}' })
          return yield* Effect.flip(prompt.render(context))
        }),
      ),
    )
    expect(error.code).toBe('unknown-variable')
  })
})

describe('build', () => {
  test('returns the rendered prompt together with the model-facing tools', async () => {
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          yield* prompt.section({ name: 'a', order: 0, text: 'system text' })
          const tools = yield* Tools
          yield* tools.register({
            name: 'echo',
            description: 'Echo',
            parameters: Schema.Struct({ text: Schema.String }),
            output: {
              schema: Schema.Struct({ text: Schema.String }),
              render: (_args, value) => [{ type: 'text' as const, text: value.text }],
            },
            execute: (args) => Effect.succeed({ text: args.text }),
          })
          return yield* prompt.build(context)
        }).pipe(Effect.provide(toolsLayer), Effect.provide(HooksLive)),
      ),
    )

    expect(built.system).toBe('system text')
    expect(built.tools.map((tool) => tool.name)).toEqual(['echo'])
  })

  test('shows the argument and result types of the tools this request can call', async () => {
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          for (const section of builtinSections({
            includeHarnessIdentity: false,
            includeToolGuidance: false,
          })) {
            yield* prompt.section(section)
          }
          const tools = yield* Tools
          yield* tools.register({
            name: 'echo',
            description: 'Echo',
            parameters: Schema.Struct({ text: Schema.String }),
            output: {
              schema: Schema.Struct({ text: Schema.String }),
              render: (_args, value) => [{ type: 'text' as const, text: value.text }],
            },
            execute: (args) => Effect.succeed({ text: args.text }),
          })
          return yield* prompt.build(context)
        }),
      ).pipe(Effect.provide(toolsLayer), Effect.provide(HooksLive)),
    )

    expect(built.system).toContain('Tools visible in this request')
    expect(built.system).toContain('echo(text: string) -> { text: string }')
  })
})

describe('SystemPrompt service', () => {
  test('is available through the context', async () => {
    const text = await Effect.runPromise(
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* prompt.section({ name: 'a', order: 0, text: 'A' })
            return yield* prompt.render(context)
          }),
        )
      }).pipe(Effect.provide(systemPromptLayer)),
    )

    // The layer's built-in sections sort after a section that shares order 0 by name.
    expect(text.startsWith('A')).toBe(true)
    expect(text).toContain('You are an AI coding agent powered by jozo-harness.')
  })
})
