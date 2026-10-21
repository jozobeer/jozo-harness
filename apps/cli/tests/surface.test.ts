import { describe, expect, test } from 'vitest'
import { Schema } from 'effect'
import { FLAG_NAMES } from '../src/args.ts'
import { ConfigFileSchema } from '../src/config-file.ts'
import { SETTINGS_KEYS, renderSurface } from '../src/surface.ts'

describe('the notes the dump prints', () => {
  test('every settings key the schema accepts has a note', () => {
    const document = Schema.toJsonSchemaDocument(ConfigFileSchema)
    const schema = document.schema as { readonly properties?: Readonly<Record<string, unknown>> }
    const keys = Object.keys(schema.properties ?? {})

    expect(SETTINGS_KEYS.map((note) => note.name).sort()).toEqual(keys.sort())
  })

  test('renderSurface tells where the settings live and what else is read', () => {
    const text = renderSurface('/tmp/jzh/config.yaml', undefined)

    expect(text).toContain('settings (/tmp/jzh/config.yaml):')
    expect(text).toContain('  - model: not set')
    expect(text).toContain('  - plugins: not set')
    expect(text).toContain(FLAG_NAMES.join(' '))
    expect(text).toContain('XDG_CONFIG_HOME')
    expect(text).toContain('BRAVE_API_KEY')
    expect(text).toContain('DEEPSEEK_API_KEY')
    expect(text).toContain('  - planMode ')
  })

  test('renderSurface shows the value each settings key holds', () => {
    const text = renderSurface('/tmp/jzh/config.yaml', {
      model: 'my-cloud/some-model',
      profile: 'repl',
      port: 4310,
      search: 'deepseek',
      deepseekToolsBaseUrl: 'https://api.deepseek.com/v1/tools',
      skills: ['/tmp/skills'],
      plugins: [{ id: 'safety', name: '@jozo-harness/safety' }],
    })

    expect(text).toContain('  - model: my-cloud/some-model ')
    expect(text).toContain('  - profile: repl ')
    expect(text).toContain('  - port: 4310 ')
    expect(text).toContain('  - search: deepseek ')
    expect(text).toContain('  - deepseekToolsBaseUrl: https://api.deepseek.com/v1/tools ')
    expect(text).toContain('  - skills: 1 directory ')
    expect(text).toContain('  - plugins: 1 row ')
  })

  test('renderSurface lists what each list key holds', () => {
    const text = renderSurface('/tmp/jzh/config.yaml', {
      skills: ['/tmp/skills', '~/work/skills'],
      plugins: [
        { id: 'safety', name: '@jozo-harness/safety', config: { preset: 'full' } },
        { id: 'ask', name: '@jozo-harness/ask', disabled: true },
      ],
    })

    expect(text).toContain('      /tmp/skills\n')
    expect(text).toContain('      ~/work/skills\n')
    expect(text).toContain('      safety → @jozo-harness/safety (preset: full)\n')
    expect(text).toContain('      ask → @jozo-harness/ask (disabled)\n')
  })
})
