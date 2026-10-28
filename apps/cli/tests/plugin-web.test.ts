import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeAsk } from '@jozo-harness/safety'
import type { PluginRow } from '@jozo-harness/kernel'
import { makeWebPluginsPort } from '../src/plugin-web.ts'
import { makePluginWiringState } from '../src/plugin-wiring.ts'
import { bundledPlugins, optionalBundles } from '../src/plugins.ts'

const tempSettings = (): string =>
  join(mkdtempSync(join(tmpdir(), 'jzh-plugin-web-')), 'config.yaml')

const portFor = async (
  settingsPath: string,
  rows: ReadonlyArray<PluginRow> = [],
  wiring = makePluginWiringState(),
) =>
  makeWebPluginsPort({
    rows,
    settingsPath,
    plugins: bundledPlugins,
    catalog: optionalBundles,
    wiring,
    ask: await Effect.runPromise(makeAsk()),
  })

describe('the web plugin port', () => {
  test('installs a catalog bundle by writing its row for the next start', async () => {
    const settingsPath = tempSettings()
    const port = await portFor(settingsPath)

    const answer = await port.change({
      action: 'install',
      id: 'artifact',
      name: '@jozo-harness/artifact',
    })

    expect(answer).toEqual({ ok: true })
    const text = readFileSync(settingsPath, 'utf8')
    expect(text).toContain('id: artifact')
    expect(text).toContain("name: '@jozo-harness/artifact'")
    expect(port.view().rows).toEqual([
      { id: 'artifact', name: '@jozo-harness/artifact', enabled: true, running: false },
    ])
    expect(port.view().catalog.find((entry) => entry.id === 'artifact')?.installed).toBe(true)
  })

  test('refuses a bundle whose config the page cannot write, and writes nothing', async () => {
    const settingsPath = tempSettings()
    const port = await portFor(settingsPath)

    const answer = await port.change({ action: 'install', id: 'mcp', name: '@jozo-harness/mcp' })

    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.message).toContain('needs config')
    expect(existsSync(settingsPath)).toBe(false)
  })

  test('refuses an install whose name is not in the catalog before writing anything', async () => {
    const settingsPath = tempSettings()
    const port = await portFor(settingsPath)

    const answer = await port.change({
      action: 'install',
      id: 'made-up',
      name: '@jozo-harness/made-up',
    })

    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.message).toContain('is not a bundle this page installs')
    expect(existsSync(settingsPath)).toBe(false)
  })

  test('switches a row off in the settings while this run keeps it', async () => {
    const settingsPath = tempSettings()
    const port = await portFor(settingsPath, [{ id: 'lsp', name: '@jozo-harness/lsp' }])

    const answer = await port.change({ action: 'set-enabled', id: 'lsp', enabled: false })

    expect(answer).toEqual({ ok: true })
    expect(readFileSync(settingsPath, 'utf8')).toContain('disabled: true')
    expect(port.view().rows).toEqual([
      { id: 'lsp', name: '@jozo-harness/lsp', enabled: false, running: true },
    ])
  })

  test('refuses an install whose row id another row already uses', async () => {
    const settingsPath = tempSettings()
    const port = await portFor(settingsPath, [{ id: 'artifact', name: '@jozo-harness/browser' }])

    const answer = await port.change({
      action: 'install',
      id: 'artifact',
      name: '@jozo-harness/artifact',
    })

    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.status).toBe(409)
    expect(existsSync(settingsPath)).toBe(false)
  })

  test('answers the reason the settings gave when a change cannot be written', async () => {
    const settingsPath = tempSettings()
    writeFileSync(settingsPath, 'plugins: []\n')
    const port = await portFor(settingsPath, [{ id: 'lsp', name: '@jozo-harness/lsp' }])

    const answer = await port.change({ action: 'set-enabled', id: 'lsp', enabled: false })

    expect(answer.ok).toBe(false)
    if (!answer.ok) {
      expect(answer.status).toBe(409)
      expect(answer.message).toContain('the settings refused the change')
    }
  })

  test('a row already in the asked state answers without another write', async () => {
    const settingsPath = tempSettings()
    const port = await portFor(settingsPath, [{ id: 'lsp', name: '@jozo-harness/lsp' }])

    const answer = await port.change({ action: 'set-enabled', id: 'lsp', enabled: true })

    expect(answer).toEqual({ ok: true })
    expect(existsSync(settingsPath)).toBe(false)
  })

  test('refuses a change for a row this run does not hold', async () => {
    const settingsPath = tempSettings()
    const port = await portFor(settingsPath)

    const answer = await port.change({ action: 'set-enabled', id: 'lsp', enabled: false })

    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.message).toContain('no plugin row with that id: lsp')
    expect(existsSync(settingsPath)).toBe(false)
  })

  test('answers the failures a retry left, and drops the row once the wiring lands', async () => {
    const settingsPath = tempSettings()
    const wiring = makePluginWiringState()
    let attempts = 0
    wiring.record('lsp', '@jozo-harness/lsp', 'the language server did not start', () =>
      Effect.sync(() => {
        attempts += 1
        wiring.clear('lsp')
      }),
    )
    const port = await portFor(settingsPath, [{ id: 'lsp', name: '@jozo-harness/lsp' }], wiring)

    expect(port.view().failures).toEqual([
      { id: 'lsp', name: '@jozo-harness/lsp', reason: 'the language server did not start' },
    ])
    const answer = await port.change({ action: 'retry', id: 'lsp' })

    expect(answer).toEqual({ ok: true })
    expect(attempts).toBe(1)
    expect(port.view().failures).toEqual([])
  })

  test('a retry for a row without a recorded failure is refused', async () => {
    const settingsPath = tempSettings()
    const port = await portFor(settingsPath)

    const answer = await port.change({ action: 'retry', id: 'lsp' })

    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.message).toContain('no plugin row failed with that id: lsp')
  })
})
