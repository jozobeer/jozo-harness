import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Effect, Result, Schema } from 'effect'
import type { Plugin, PluginRow } from '@jozo-harness/kernel'
import type { AskShape } from '@jozo-harness/safety'
import { ToolError } from '@jozo-harness/tools'
import type {
  PluginChange,
  PluginChangeOutcome,
  PluginHost,
  PluginRowSummary,
  PluginUnmount,
} from '@jozo-harness/tools-tier1'
import { parseConfigText } from './config-file.ts'
import { applyEdit, type SettingsEdit } from './settings-edit.ts'

export interface PluginHostOptions {
  /** The rows this run was built from, in the order they were layered. */
  readonly rows: ReadonlyArray<PluginRow>
  /** The plugins this build can wire. */
  readonly plugins: ReadonlyArray<Plugin<any, any, any>>
  readonly settingsPath: string
  readonly ask: AskShape
  /**
   * Builds one added row over the services this run already holds and returns
   * the tools it wired. Absent when this caller cannot mount anything.
   */
  readonly mount?: (row: PluginRow) => Effect.Effect<ReadonlyArray<string>, ToolError>
  /**
   * Takes one row this run wired back out and says what left with it. Absent when
   * this caller cannot unwire a row, which is every change but a wired row's own.
   */
  readonly unmount?: (id: string) => Effect.Effect<PluginUnmount, ToolError>
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
const unloadable = (
  change: PluginChange,
  plugins: ReadonlyArray<Plugin<any, any, any>>,
): ToolError | undefined => {
  if (change.kind !== 'add') return undefined
  const plugin: Plugin<any, any, any> | undefined = plugins.find((one) => one.name === change.name)
  if (plugin === undefined) {
    return new ToolError({
      code: 'invalid-arguments',
      message:
        'this build does not have ' +
        change.name +
        '; it has ' +
        plugins.map((one) => one.name).join(', '),
    })
  }
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
 * A row written with a config cannot be taken back out of a running run yet: the
 * services it built are not the ones a mounted row owns. The call is refused
 * before anything is written, and switching the row off stays available.
 */
const carriesConfig = (
  change: PluginChange,
  configured: ReadonlySet<string>,
): ToolError | undefined => {
  if (change.kind !== 'remove' || !configured.has(change.id)) return undefined
  return new ToolError({
    code: 'invalid-arguments',
    message:
      'the row ' +
      change.id +
      ' carries config, and this run cannot take such a row back out yet; the settings and the tools are unchanged (set disabled=true switches it off from the next start)',
  })
}

/** Adding a row for a plugin this run already holds under the same id only changes the settings. */
const overridesActive = (rows: ReadonlyArray<PluginRow>, change: PluginChange): boolean =>
  change.kind === 'add' &&
  rows.some((row) => row.id === change.id && row.name === change.name && row.disabled !== true)

const mountFor = (
  options: PluginHostOptions,
  change: PluginChange,
  edited: boolean,
): Effect.Effect<ReadonlyArray<string>, ToolError> => {
  if (
    !edited ||
    options.mount === undefined ||
    change.kind !== 'add' ||
    overridesActive(options.rows, change)
  ) {
    return Effect.succeed([])
  }
  return options.mount({ id: change.id, name: change.name })
}

/** The list keeps a row this change mounted, so a later call sees the running composition. */
const remember = (
  rows: Array<PluginRowSummary>,
  change: PluginChange,
  mounted: ReadonlyArray<string>,
): void => {
  if (mounted.length === 0 || change.kind !== 'add') return
  const added: PluginRowSummary = { id: change.id, name: change.name, disabled: false }
  const at = rows.findIndex((row) => row.id === change.id)
  if (at === -1) rows.push(added)
  else rows[at] = added
}

/** A row this run took back out no longer belongs to the rows it lists. */
const forget = (rows: Array<PluginRowSummary>, change: PluginChange): void => {
  if (change.kind !== 'remove') return
  const at = rows.findIndex((row) => row.id === change.id)
  if (at !== -1) rows.splice(at, 1)
}

/** Keeps the rows this run lists in step with what this change moved into or out of it. */
const settleRows = (
  rows: Array<PluginRowSummary>,
  configured: Set<string>,
  change: PluginChange,
  mounted: ReadonlyArray<string>,
  unmounted: PluginUnmount,
): void => {
  remember(rows, change, mounted)
  if (mounted.length > 0 && change.kind === 'add') configured.delete(change.id)
  if (unmounted.detached) forget(rows, change)
}

/** The release waits until the settings are edited, so a refused edit unwires nothing. */
const unmountFor = (
  options: PluginHostOptions,
  change: PluginChange,
  edited: boolean,
): Effect.Effect<PluginUnmount, ToolError> => {
  if (!edited || change.kind !== 'remove' || options.unmount === undefined) {
    return Effect.succeed({ detached: false, tools: [] })
  }
  return options.unmount(change.id)
}

const writeSettings = (path: string, text: string): Effect.Effect<void, ToolError> =>
  Effect.try({
    try: () => writeFileSync(path, text),
    catch: () => failure('cannot write the settings: ' + path),
  })

/**
 * The plugin rows as the settings file holds them: the tool reads them and writes
 * one change, and the CLI hands the same file to the next start. A row the caller
 * can build now is mounted before the write, so a row that would not load leaves
 * the settings as they were.
 */
export const makePluginHost = (options: PluginHostOptions): PluginHost => {
  // A mounted row joins the composition this run knows; a row left to the next
  // start does not, so list keeps answering for the running process.
  const liveRows: Array<PluginRowSummary> = options.rows.map(summaryOf)
  // Only a row written without config can be unmounted; a mounted one joins that
  // set with no config of its own.
  const configured = new Set(
    options.rows.filter((row) => row.config !== undefined).map((row) => row.id),
  )
  return {
    rows: () => [...liveRows],
    known: () => options.plugins.map((plugin) => plugin.name),
    ask: options.ask,
    change: (change) =>
      Effect.gen(function* () {
        const refused = unloadable(change, options.plugins) ?? carriesConfig(change, configured)
        if (refused !== undefined) return yield* Effect.fail(refused)
        const path = options.settingsPath
        const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
        const edited = yield* applyEdit(text, editFor(change)).pipe(
          Effect.mapError((error) =>
            failure('the settings refused the change (' + error.code + '): ' + error.about),
          ),
        )
        const mounted = yield* mountFor(options, change, edited.changed)
        const unmounted = yield* unmountFor(options, change, edited.changed)
        if (edited.changed) yield* writeSettings(path, edited.text)
        settleRows(liveRows, configured, change, mounted, unmounted)
        const parsed = yield* parseConfigText(edited.text).pipe(
          Effect.mapError((error) => failure(error.message)),
        )
        return {
          rows: (parsed.plugins ?? []).map(summaryOf),
          mounted,
          detached: unmounted.detached,
          unmounted: unmounted.tools,
        } satisfies PluginChangeOutcome
      }),
  }
}
