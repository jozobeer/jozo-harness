import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  test('removing a row this run wired takes its tools back and drops it from the settings', async () => {
    const settingsPath = tempSettings()
    writeFileSync(settingsPath, "plugins:\n  - id: lsp\n    name: '@jozo-harness/lsp'\n")
    const released: Array<string> = []
    const host = makePluginHost({
      rows: [{ id: 'lsp', name: '@jozo-harness/lsp' }],
      plugins: bundledPlugins,
      settingsPath,
      ask: await Effect.runPromise(makeAsk()),
      unmount: (id) =>
        Effect.sync(() => {
          released.push(id)
          return { detached: true, tools: ['lsp_hover'] }
        }),
    })

    const outcome = await Effect.runPromise(host.change({ kind: 'remove', id: 'lsp' }))

    expect(released).toEqual(['lsp'])
    expect(outcome.detached).toBe(true)
    expect(outcome.unmounted).toEqual(['lsp_hover'])
    expect(outcome.rows).toEqual([])
    expect(host.rows()).toEqual([])
    expect(readFileSync(settingsPath, 'utf8')).toBe('')
  })

  test('a refused unmount leaves the settings and the rows as they were', async () => {
    const settingsPath = tempSettings()
    const text = "plugins:\n  - id: lsp\n    name: '@jozo-harness/lsp'\n"
    writeFileSync(settingsPath, text)
    const host = makePluginHost({
      rows: [{ id: 'lsp', name: '@jozo-harness/lsp' }],
      plugins: bundledPlugins,
      settingsPath,
      ask: await Effect.runPromise(makeAsk()),
      unmount: () =>
        Effect.fail(
          new ToolError({ code: 'invalid-arguments', message: 'the row lsp stays in this run' }),
        ),
    })

    const failed = await Effect.runPromise(Effect.flip(host.change({ kind: 'remove', id: 'lsp' })))

    expect(failed.message).toContain('the row lsp stays in this run')
    expect(readFileSync(settingsPath, 'utf8')).toBe(text)
    expect(host.rows()).toEqual([{ id: 'lsp', name: '@jozo-harness/lsp', disabled: false }])
  })

  test('removing a row that carries config is refused before anything changes', async () => {
    const settingsPath = tempSettings()
    const text =
      "plugins:\n  - id: session-jsonl\n    name: '@jozo-harness/session-jsonl'\n    config:\n      root: /tmp/sessions\n"
    writeFileSync(settingsPath, text)
    const host = makePluginHost({
      rows: [
        {
          id: 'session-jsonl',
          name: '@jozo-harness/session-jsonl',
          config: { root: '/tmp/sessions' },
        },
      ],
      plugins: bundledPlugins,
      settingsPath,
      ask: await Effect.runPromise(makeAsk()),
      unmount: () => Effect.sync(() => ({ detached: true, tools: [] })),
    })

    const failed = await Effect.runPromise(
      Effect.flip(host.change({ kind: 'remove', id: 'session-jsonl' })),
    )

    expect(failed.code).toBe('invalid-arguments')
    expect(failed.message).toContain('carries config')
    expect(readFileSync(settingsPath, 'utf8')).toBe(text)
    expect(host.rows()).toHaveLength(1)
  })

  test('removing a row this run did not wire only changes the settings', async () => {
    const settingsPath = tempSettings()
    writeFileSync(settingsPath, "plugins:\n  - id: tier1\n    name: '@jozo-harness/tools-tier1'\n")
    const host = makePluginHost({
      rows: [{ id: 'tier1', name: '@jozo-harness/tools-tier1' }],
      plugins: bundledPlugins,
      settingsPath,
      ask: await Effect.runPromise(makeAsk()),
      unmount: () => Effect.succeed({ detached: false, tools: [] }),
    })

    const outcome = await Effect.runPromise(host.change({ kind: 'remove', id: 'tier1' }))

    expect(outcome.detached).toBe(false)
    expect(outcome.rows).toEqual([])
    // The run still holds the row, so list keeps naming it until the next start.
    expect(host.rows()).toHaveLength(1)
    expect(readFileSync(settingsPath, 'utf8')).toBe('')
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
