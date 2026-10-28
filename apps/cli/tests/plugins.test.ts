import { describe, expect, test } from 'vitest'
import { loadBundledProfile } from '@jozo-harness/bundle-base'
import { parseProfile } from '@jozo-harness/kernel'
import { Effect, Result, Schema } from 'effect'
import { bundledPlugins, optionalBundles } from '../src/plugins.ts'

const names = (): ReadonlyArray<string> => bundledPlugins.map((plugin) => plugin.name)

describe('the plugins the command can assemble', () => {
  test('has every plugin the bundled profile names', async () => {
    const text = await loadBundledProfile()
    const profile = await Effect.runPromise(parseProfile(text))

    for (const row of profile.plugins) expect(names()).toContain(row.name)
  })

  test('has the mcp plugin, so a settings row can name it', () => {
    expect(names()).toContain('@jozo-harness/mcp')
  })

  test('lists each optional bundle once with a name this build carries', () => {
    const ids = optionalBundles.map((bundle) => bundle.id)
    const offered = optionalBundles.map((bundle) => bundle.name)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(offered).size).toBe(offered.length)
    for (const name of offered) expect(names()).toContain(name)
  })

  test('marks exactly the bundles an id-and-name row cannot load as needing config', () => {
    for (const bundle of optionalBundles) {
      const plugin = bundledPlugins.find((one) => one.name === bundle.name)
      if (plugin === undefined) throw new Error('the catalog names a plugin the build lacks')
      const config = plugin.config as unknown as Parameters<typeof Schema.decodeUnknownResult>[0]
      const decoded = Schema.decodeUnknownResult(config)({})
      expect(Result.isSuccess(decoded)).toBe(!bundle.needsConfig)
    }
  })
})
