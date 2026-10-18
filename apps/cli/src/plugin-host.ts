import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Effect, Result, Schema } from 'effect'
import type { Plugin, PluginRow } from '@jozo-harness/kernel'
import type { AskShape } from '@jozo-harness/safety'
import { ToolError } from '@jozo-harness/tools'
import type { PluginChange, PluginHost, PluginRowSummary } from '@jozo-harness/tools-tier1'
import { parseConfigText } from './config-file.ts'
import { bundledPlugins } from './plugins.ts'
import { applyEdit, type SettingsEdit } from './settings-edit.ts'

export interface PluginHostOptions {
  /** The rows this run was built from, in the order they were layered. */
  readonly rows: ReadonlyArray<PluginRow>
  /** The plugin names this build can wire. */
  readonly known: ReadonlyArray<string>
  readonly settingsPath: string
  readonly ask: AskShape
}

const summaryOf = (row: PluginRow): PluginRowSummary => ({
  id: row.id,
  name: row.name,
  disabled: row.disabled === true,
})

const editFor = (change: PluginChange): SettingsEdit => {
  if (change.kind === 'add') return { kind: 'add-row', id: change.id, name: change.name }
  if (change.kind === 'remove') return { kind: 'remove-row', id: change.id }
  // set-row writes the override into the settings, even for a row a profile provides.
  return {
    kind: 'set-row',
    id: change.id,
    name: change.name,
    key: 'disabled',
    value: change.disabled ? 'true' : 'false',
  }
}

const failure = (message: string): ToolError => new ToolError({ code: 'execution', message })

/**
 * A row is written with its id and name only, so the config it would carry is
 * empty. A plugin whose config the empty one does not satisfy cannot be built
 * by the next start, and a start that fails is one a human has to repair by
 * hand: refuse it here, where the model still reads why.
 */
const unloadable = (change: PluginChange): ToolError | undefined => {
  if (change.kind !== 'add') return undefined
  const plugin: Plugin<any, any, any> | undefined = bundledPlugins.find(
    (one) => one.name === change.name,
  )
  if (plugin === undefined) return undefined
  // `Plugin` erases the services a config needs; the loader narrows the same way.
  const config: Parameters<typeof Schema.decodeUnknownResult>[0] =
    plugin.config as unknown as Parameters<typeof Schema.decodeUnknownResult>[0]
  const decoded = Schema.decodeUnknownResult(config)({})
  if (Result.isSuccess(decoded)) return undefined
  return new ToolError({
    code: 'invalid-arguments',
    message:
      'the row ' +
      change.id +
      ' (' +
      change.name +
      ') would not load when jozo-harness starts again: config of ' +
      change.id +
      ' is invalid: ' +
      decoded.failure.message +
      '; this tool writes a row with an id and a name only, so add the config it needs to the settings by hand',
  })
}

/**
 * The plugin rows as the settings file holds them: the tool reads them and writes
 * one change, and the CLI hands the same file to the next start.
 */
export const makePluginHost = (options: PluginHostOptions): PluginHost => ({
  rows: () => options.rows.map(summaryOf),
  known: () => options.known,
  ask: options.ask,
  change: (change) =>
    Effect.gen(function* () {
      const refused = unloadable(change)
      if (refused !== undefined) return yield* Effect.fail(refused)
      const path = options.settingsPath
      const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
      const edited = yield* applyEdit(text, editFor(change)).pipe(
        Effect.mapError((error) =>
          failure('the settings refused the change (' + error.code + '): ' + error.about),
        ),
      )
      if (edited.changed) {
        yield* Effect.try({
          try: () => writeFileSync(path, edited.text),
          catch: () => failure('cannot write the settings: ' + path),
        })
      }
      const parsed = yield* parseConfigText(edited.text).pipe(
        Effect.mapError((error) => failure(error.message)),
      )
      return (parsed.plugins ?? []).map(summaryOf)
    }),
})
