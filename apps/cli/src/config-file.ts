import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { PluginError, PluginRowSchema, yamlFailure, type PluginRow } from '@jozo-harness/kernel'
import { Effect, Schema } from 'effect'

/** The settings file: defaults for the command line plus extra plugin rows. */
export const ConfigFileSchema = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  search: Schema.optionalKey(Schema.Literals(['brave', 'deepseek'])),
  deepseekToolsBaseUrl: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  plugins: Schema.optionalKey(Schema.Array(PluginRowSchema)),
})

export interface JozoHarnessConfig {
  readonly model?: string | undefined
  readonly effort?: string | undefined
  readonly profile?: string | undefined
  readonly search?: 'brave' | 'deepseek' | undefined
  readonly deepseekToolsBaseUrl?: string | undefined
  readonly skills?: ReadonlyArray<string> | undefined
  readonly plugins?: ReadonlyArray<PluginRow> | undefined
}

const configError = (message: string): PluginError => new PluginError({ code: 'config', message })

/** Parses one YAML settings document. Unknown keys are ignored on purpose. */
export function parseConfigText(text: string): Effect.Effect<JozoHarnessConfig, PluginError> {
  return Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => parse(text) as unknown,
      catch: (cause) => configError('settings are not valid YAML: ' + yamlFailure(cause)),
    })
    // An empty document, or one holding only comments, is no settings at all.
    if (raw === null || raw === undefined) return {}
    return yield* Schema.decodeUnknownEffect(ConfigFileSchema)(raw).pipe(
      Effect.mapError((issue) => configError('settings do not match the schema: ' + issue.message)),
    )
  })
}

/** A settings file that is not there is simply no settings. */
export function loadConfigFile(path: string): Effect.Effect<JozoHarnessConfig, PluginError> {
  return Effect.gen(function* () {
    if (!existsSync(path)) return {}
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: (cause) => configError('cannot read ' + path + ': ' + String(cause)),
    })
    return yield* parseConfigText(text)
  })
}
