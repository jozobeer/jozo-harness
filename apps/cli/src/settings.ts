import type { PluginRow } from '@jozo-harness/kernel'
import type { JozoHarnessConfig } from './config-file.ts'

/** Where an effective value came from, nearest first. */
export type SettingSource = 'flag' | 'settings' | 'environment' | 'default'

/** One effective value, and what decided it. */
export interface Resolved<T> {
  readonly value: T
  readonly source: SettingSource
  /** The thing that decided it, named the way a person would say it. */
  readonly from: string
}

export interface SettingsInputs {
  /** The command line, which wins over everything. */
  readonly flags: {
    readonly profile?: string | undefined
    readonly model?: string | undefined
    readonly effort?: string | undefined
    /** The --port; 0 is a real choice, so an omitted flag is undefined. */
    readonly port?: number | undefined
  }
  readonly settings: JozoHarnessConfig
  readonly settingsPath: string
  /** The profile name when neither a flag nor the settings file chooses one. */
  readonly fallbackProfile: string
  /** The route when neither a flag nor the settings file chooses one. */
  readonly fallbackRoute: string
  /** The effort a plugin row names, when neither a flag nor the settings file does. */
  readonly fallbackEffort?: string | undefined
}

export interface EffectiveSettings {
  readonly profile: Resolved<string>
  readonly route: Resolved<string>
  /** The reasoning effort to ask for; '' leaves the choice to the provider. */
  readonly effort: Resolved<string>
  /** The port `jzh web` listens on; 0 asks the system for a free one. */
  readonly port: Resolved<number>
  readonly skills: Resolved<ReadonlyArray<string>>
  readonly plugins: Resolved<ReadonlyArray<PluginRow>>
}

const named = (value: string | undefined): value is string => value !== undefined && value !== ''

/**
 * The first candidate that has a value decides, and it says so. One place answers
 * "what is in effect, and why" for the run path and for `jzh config`, so the two
 * cannot drift apart.
 */
const first = <T>(
  candidates: ReadonlyArray<readonly [T | undefined, SettingSource, string]>,
  fallback: readonly [T, string],
): Resolved<T> => {
  for (const [value, source, from] of candidates) {
    if (value !== undefined) return { value, source, from }
  }
  return { value: fallback[0], source: 'default', from: fallback[1] }
}

const fromFile = <T>(value: T | undefined, path: string, empty: T, what: string): Resolved<T> =>
  value === undefined
    ? { value: empty, source: 'default', from: what }
    : { value, source: 'settings', from: path }

/** One value where a flag, then the settings file, then a default decides it. */
const layered = <T>(
  flag: T | undefined,
  flagFrom: string,
  file: T | undefined,
  path: string,
  fallback: readonly [T, string],
): Resolved<T> =>
  first(
    [
      [flag, 'flag', flagFrom],
      [file, 'settings', path],
    ],
    fallback,
  )

/** A string setting, where an empty flag reads as no flag at all. */
const layeredString = (
  flag: string | undefined,
  flagFrom: string,
  file: string | undefined,
  path: string,
  fallback: readonly [string, string],
): Resolved<string> =>
  layered(named(flag) ? flag : undefined, flagFrom, named(file) ? file : undefined, path, fallback)

/** Resolves the settings a run will use, each with the source that decided it. */
export const resolveSettings = (inputs: SettingsInputs): EffectiveSettings => ({
  profile: layeredString(
    inputs.flags.profile,
    'the --profile on the command line',
    inputs.settings.profile,
    inputs.settingsPath,
    [inputs.fallbackProfile, 'the profile named on the command line'],
  ),
  route: layeredString(
    inputs.flags.model,
    'the --model on the command line',
    inputs.settings.model,
    inputs.settingsPath,
    [inputs.fallbackRoute, 'the model named on the command line'],
  ),
  effort: layeredString(
    inputs.flags.effort,
    'the --effort on the command line',
    inputs.settings.effort,
    inputs.settingsPath,
    [inputs.fallbackEffort ?? '', 'no effort is named, so the provider chooses'],
  ),
  port: layered(
    inputs.flags.port,
    'the --port on the command line',
    inputs.settings.port,
    inputs.settingsPath,
    [0, 'no port is named, so the system picks a free one'],
  ),
  skills: fromFile(
    inputs.settings.skills,
    inputs.settingsPath,
    [],
    'no skills configured, so the skill tool is off',
  ),
  plugins: fromFile(inputs.settings.plugins, inputs.settingsPath, [], 'no extra plugin rows'),
})

/** The file a credential came from: the shell, the nearest .env, or secrets.env. */
export type CredentialSource = 'environment' | 'dotenv' | 'secrets'

export interface CredentialInputs {
  readonly name: string
  readonly environment: Readonly<Record<string, string | undefined>>
  /** Names the nearest .env filled, and secrets.env filled after it. */
  readonly fromDotenv: ReadonlyArray<string>
  readonly fromSecrets: ReadonlyArray<string>
}

/** What the run path resolved, and what the file loaders had to fill. */
export interface SettingsSurface {
  readonly effective: EffectiveSettings
  readonly filled: {
    readonly fromDotenv: ReadonlyArray<string>
    readonly fromSecrets: ReadonlyArray<string>
  }
}

/**
 * Where one credential came from. The loaders only fill what the shell leaves
 * empty, so a name they filled was not in the shell: .env is nearer than
 * secrets.env, which is the file to keep unreadable.
 */
export const credentialSource = (inputs: CredentialInputs): CredentialSource | undefined => {
  // The nearest source that filled it wins, and the shell is not in either list
  // because the file loaders never overwrite it.
  if (inputs.fromDotenv.includes(inputs.name)) return 'dotenv'
  if (inputs.fromSecrets.includes(inputs.name)) return 'secrets'
  const present = inputs.environment[inputs.name]
  return present !== undefined && present !== '' ? 'environment' : undefined
}
