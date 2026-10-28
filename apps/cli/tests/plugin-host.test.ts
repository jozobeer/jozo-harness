import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import type { PluginRow } from '@jozo-harness/kernel'
import { makeAsk } from '@jozo-harness/safety'
import { ToolError } from '@jozo-harness/tools'
import type { PluginChangeOutcome } from '@jozo-harness/tools-tier1'
import { makePluginHost } from '../src/plugin-host.ts'
import { bundledPlugins } from '../src/plugins.ts'

const hostFor = async (
  settingsPath: string,
  mount?: Parameters<typeof makePluginHost>[0]['mount'],
) =>
  makePluginHost({
    rows: [],
    plugins: bundledPlugins,
    settingsPath,
    ask: await Effect.runPromise(makeAsk()),
    ...(mount === undefined ? {} : { mount }),
  })

const changed = (
  settingsPath: string,
  change: Parameters<ReturnType<typeof makePluginHost>['change']>[0],
  mount?: Parameters<typeof makePluginHost>[0]['mount'],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* Effect.promise(() => hostFor(settingsPath, mount))
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

    const outcome: PluginChangeOutcome = await changed(settingsPath, {
      kind: 'add',
      id: 'tier1',
      name: '@jozo-harness/tools-tier1',
    })

    expect(outcome.rows).toEqual([
      { id: 'tier1', name: '@jozo-harness/tools-tier1', disabled: false },
    ])
    expect(outcome.mounted).toEqual([])
    expect(readFileSync(settingsPath, 'utf8')).toBe(
      "plugins:\n  - id: tier1\n    name: '@jozo-harness/tools-tier1'\n",
    )
  })

  test('mounts an added row before it writes the settings', async () => {
    const settingsPath = tempSettings()
    const mounted: Array<PluginRow> = []

    const outcome = await changed(
      settingsPath,
      { kind: 'add', id: 'tier1', name: '@jozo-harness/tools-tier1' },
      (row) =>
        Effect.sync(() => {
          mounted.push(row)
          return ['tier1_tool']
        }),
    )

    expect(mounted).toEqual([{ id: 'tier1', name: '@jozo-harness/tools-tier1' }])
    expect(outcome.mounted).toEqual(['tier1_tool'])
    expect(outcome.rows).toHaveLength(1)
    expect(readFileSync(settingsPath, 'utf8')).toContain('id: tier1')
  })

  test('lists a row it mounted into this run', async () => {
    const settingsPath = tempSettings()
    const host = await hostFor(settingsPath, () => Effect.succeed(['tier1_tool']))

    await Effect.runPromise(
      host.change({ kind: 'add', id: 'tier1', name: '@jozo-harness/tools-tier1' }),
    )

    expect(host.rows()).toEqual([
      { id: 'tier1', name: '@jozo-harness/tools-tier1', disabled: false },
    ])
  })

  test('a mount failure writes nothing and leaves the rows as they were', async () => {
    const settingsPath = tempSettings()

    const failed = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* Effect.promise(() =>
          hostFor(settingsPath, () =>
            Effect.fail(new ToolError({ code: 'execution', message: 'cannot build the row' })),
          ),
        )
        const error = yield* Effect.flip(
          host.change({ kind: 'add', id: 'tier1', name: '@jozo-harness/tools-tier1' }),
        )
        return { error, rows: host.rows() }
      }),
    )

    expect(failed.error.message).toContain('cannot build the row')
    expect(failed.rows).toEqual([])
    expect(existsSync(settingsPath)).toBe(false)
  })
})
