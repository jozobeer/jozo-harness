import { describe, expect, test } from 'vitest'
import type { ToolSchema } from '@jozo-harness/llm'
import { Effect } from 'effect'
import {
  IDENTITY_TEXT,
  SystemPrompt,
  builtinSections,
  makeSystemPrompt,
  systemPromptLayer,
  systemPromptLayerWith,
  toolGuidance,
} from '../src/index.ts'

const schema = (name: string): ToolSchema => ({ name, description: name, parameters: {} })

const renderWithBuiltins = (options?: Parameters<typeof systemPromptLayerWith>[0]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt
      return yield* prompt.render({ variables: {}, tools: [schema('read')] })
    }).pipe(
      Effect.provide(options === undefined ? systemPromptLayer : systemPromptLayerWith(options)),
    ),
  )

describe('builtinSections', () => {
  test('the identity is the whole prompt when no tool has guidance', async () => {
    const rendered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          for (const section of builtinSections()) yield* prompt.section(section)
          return yield* prompt.render({ variables: {} })
        }),
      ),
    )

    expect(rendered).toBe(IDENTITY_TEXT)
    expect(rendered).toContain('You are an AI coding agent powered by jozo-harness.')
  })

  test('the guidance section sits after the identity and before user sections', () => {
    const sections = builtinSections()

    expect(sections.map((section) => section.name)).toEqual(['jzh:identity', 'jzh:tool-guidance'])
    expect(sections[0]?.order).toBeLessThan(sections[1]?.order ?? 0)
  })

  test('either built-in can be turned off', async () => {
    const withoutIdentity = await renderWithBuiltins({ includeHarnessIdentity: false })
    expect(withoutIdentity).not.toContain('powered by jozo-harness')
    expect(withoutIdentity).toContain('instead of cat')

    const withoutGuidance = await renderWithBuiltins({ includeToolGuidance: false })
    expect(withoutGuidance).toBe(IDENTITY_TEXT)
  })
})

describe('toolGuidance', () => {
  test('names only the tools this assembly can call', () => {
    const withRead = toolGuidance({ variables: {}, tools: [schema('read'), schema('edit')] })

    expect(withRead).toContain('instead of cat')
    expect(withRead).toContain('oldString')
    expect(withRead).not.toContain('todo_write')
  })

  test('a tool the table does not know contributes nothing', () => {
    expect(toolGuidance({ variables: {}, tools: [schema('mcp__fs__read')] })).toBe('')
  })

  test('no visible tools means no guidance text', () => {
    expect(toolGuidance({ variables: {} })).toBe('')
  })
})

describe('SystemPrompt service', () => {
  test('serves the built-in identity through the layer', async () => {
    const text = await Effect.runPromise(
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt
        return yield* prompt.render({ variables: {} })
      }).pipe(Effect.provide(systemPromptLayer)),
    )

    expect(text).toBe(IDENTITY_TEXT)
  })
})

describe('guidance matches the tools it describes', () => {
  test('delegation names the fork default and the batched start', () => {
    const line = toolGuidance({ variables: {}, tools: [schema('subagent')] })

    expect(line).toContain('together in one assistant message')
    expect(line).toContain('forks')
    expect(line).toContain('fresh')
  })

  test('both web tools ask for a citation', () => {
    const line = toolGuidance({ variables: {}, tools: [schema('web_fetch'), schema('web_search')] })

    expect(line.match(/markdown link/g)).toHaveLength(2)
  })
})
