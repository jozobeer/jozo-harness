import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeAsk } from '@jozo-harness/safety'
import { makePluginHost } from '../src/plugin-host.ts'
import { bundledPlugins } from '../src/plugins.ts'
import type { PluginRowSummary } from '@jozo-harness/tools-tier1'

const hostFor = async (settingsPath: string) =>
  makePluginHost({
    rows: [],
    known: bundledPlugins.map((plugin) => plugin.name),
    settingsPath,
    ask: await Effect.runPromise(makeAsk()),
  })

const changed = (
  settingsPath: string,
  change: Parameters<ReturnType<typeof makePluginHost>['change']>[0],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* Effect.promise(() => hostFor(settingsPath))
      return yield* host.change(change)
    }),
  )

const refused = (
  settingsPath: string,
  change: Parameters<ReturnType<typeof makePluginHost>['change']>[0],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* Effect.promise(() => hostFor(settingsPath))
      return yield* Effect.flip(host.change(change))
    }),
  )

const tempSettings = (): string =>
  join(mkdtempSync(join(tmpdir(), 'jzh-plugin-host-')), 'config.yaml')

describe('the plugin host', () => {
  test('refuses an add whose row the next start could not load, and writes nothing', async () => {
    const settingsPath = tempSettings()

    const failed = await refused(settingsPath, {
      kind: 'add',
      id: 'mcp',
      name: '@jozo-harness/mcp',
    })

    // The message names what the row still needs, so the model can tell the human.
    expect(failed.message).toContain('command')
    expect(failed.message).toContain('mcp')
    expect(existsSync(settingsPath)).toBe(false)
  })

  test('adds a row whose config needs nothing', async () => {
    const settingsPath = tempSettings()

    const rows: ReadonlyArray<PluginRowSummary> = await changed(settingsPath, {
      kind: 'add',
      id: 'tier1',
      name: '@jozo-harness/tools-tier1',
    })

    expect(rows).toEqual([{ id: 'tier1', name: '@jozo-harness/tools-tier1', disabled: false }])
    expect(readFileSync(settingsPath, 'utf8')).toBe(
      "plugins:\n  - id: tier1\n    name: '@jozo-harness/tools-tier1'\n",
    )
  })
})
