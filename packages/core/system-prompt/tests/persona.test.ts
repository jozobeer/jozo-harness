import { describe, expect, test } from 'vitest'
import { Effect, Schema } from 'effect'
import {
  IDENTITY_TEXT,
  SystemPrompt,
  systemPromptConfigSchema,
  systemPromptPlugin,
  type SystemPromptConfig,
} from '../src/index.ts'

const renderFromProfile = (config: SystemPromptConfig) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt
      const system = yield* prompt.render({ variables: {} })
      return { system, sections: prompt.sections().map((section) => section.name) }
    }).pipe(Effect.provide(systemPromptPlugin.layer(config))),
  )

const persona = (before?: string, after?: string) => ({
  includeToolGuidance: false,
  persona: {
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  },
})

describe('persona', () => {
  test('keeps the identity between the before prose and the after prose', async () => {
    const { system, sections } = await renderFromProfile(
      persona('Speak as the deployment owner.', 'Sign off as the deployment owner.'),
    )

    expect(system).toBe(
      'Speak as the deployment owner.\n\n' +
        IDENTITY_TEXT +
        '\n\nSign off as the deployment owner.',
    )
    expect(sections).toContain('jzh:persona-before')
    expect(sections).toContain('jzh:identity')
    expect(sections).toContain('jzh:persona-after')
  })

  test('renders no persona section when the prose is unset, empty, or whitespace', async () => {
    const cases: ReadonlyArray<SystemPromptConfig> = [
      {},
      persona(''),
      persona(undefined, ''),
      persona('  \n\t', '   '),
    ]

    for (const config of cases) {
      const { system, sections } = await renderFromProfile(config)
      expect(system).toBe(IDENTITY_TEXT)
      expect(sections.filter((name) => name.startsWith('jzh:persona'))).toEqual([])
    }
  })

  test('trims the prose so no blank line opens the section', async () => {
    const { system } = await renderFromProfile(
      persona('\n  first line\nsecond line  \n', '  afterwards  '),
    )

    expect(system).toBe('first line\nsecond line\n\n' + IDENTITY_TEXT + '\n\nafterwards')
  })

  test('assembles byte-identical prompt text for the same persona twice', async () => {
    const config = persona('be explicit about what you verified', 'cite what you read')
    const first = await renderFromProfile(config)
    const second = await renderFromProfile(config)

    expect(Buffer.from(second.system, 'utf8').equals(Buffer.from(first.system, 'utf8'))).toBe(true)
  })

  test('accepts the persona keys from a profile row', () => {
    const config = Schema.decodeUnknownSync(systemPromptConfigSchema)({
      persona: { before: 'before', after: 'after' },
    })

    expect(config.persona).toEqual({ before: 'before', after: 'after' })
  })
})
