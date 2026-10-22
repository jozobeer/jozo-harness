import { Effect, Schema } from 'effect'
import { parse } from 'yaml'
import { PluginError } from './errors.ts'

export const PluginRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  config: Schema.optional(Schema.Unknown),
  disabled: Schema.optional(Schema.Boolean),
})

/** One plugin line of a profile. The row id is the merge key across layers. */
export type PluginRow = (typeof PluginRowSchema)['Type']

/** A row takes part in a run unless its line says otherwise. */
export const isRowEnabled = (row: PluginRow): boolean => row.disabled !== true

/** A named list of plugin rows loaded from one YAML document. */
export interface Profile {
  readonly name: string
  readonly plugins: ReadonlyArray<PluginRow>
}

export const ProfileSchema = Schema.Struct({
  name: Schema.String,
  plugins: Schema.Array(PluginRowSchema),
})

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const mergeConfig = (base: unknown, patch: unknown): unknown =>
  isRecord(base) && isRecord(patch) ? { ...base, ...patch } : patch

const overlayRow = (existing: PluginRow | undefined, row: PluginRow): PluginRow =>
  existing === undefined
    ? row
    : {
        ...existing,
        ...row,
        config:
          row.config === undefined ? existing.config : mergeConfig(existing.config, row.config),
      }

/** Overlays layers by row id. A later layer wins; new ids keep their first-seen order. */
export function mergeRows(
  layers: ReadonlyArray<ReadonlyArray<PluginRow>>,
): ReadonlyArray<PluginRow> {
  const merged = new Map<string, PluginRow>()
  for (const layer of layers) {
    for (const row of layer) merged.set(row.id, overlayRow(merged.get(row.id), row))
  }
  return [...merged.values()]
}

const configError = (message: string): PluginError => new PluginError({ code: 'config', message })

/**
 * A yaml parse failure on one line: the parser's message without its code
 * frame, with the position it reported kept as "(line N, column M)".
 */
export const yamlFailure = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause)
  const first = text.split('\n')[0] ?? ''
  return first.replace(/ at line (\d+), column (\d+):$/, ' (line $1, column $2)')
}

/** Parses one YAML profile document. */
export function parseProfile(text: string): Effect.Effect<Profile, PluginError> {
  return Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => parse(text) as unknown,
      catch: (cause) => configError(`profile is not valid YAML: ${yamlFailure(cause)}`),
    })
    return yield* Schema.decodeUnknownEffect(ProfileSchema)(raw).pipe(
      Effect.mapError((issue) =>
        configError(`profile does not match the profile schema: ${issue.message}`),
      ),
    )
  })
}

/** Renders the rows the command will run for `--dump-config`. */
export function renderConfig(rows: ReadonlyArray<PluginRow>): string {
  const lines = rows.map((row) => {
    const config = row.config === undefined ? '' : ` config=${JSON.stringify(row.config)}`
    const disabled = row.disabled === true ? ' disabled' : ''
    return `  - id=${row.id} name=${row.name}${config}${disabled}`
  })
  return ['plugin rows in effect (profiles + settings file + --patch):', ...lines].join('\n') + '\n'
}
