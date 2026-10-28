import type { PluginRow } from '@jozo-harness/kernel'

/**
 * The namespace jzh owns. A command gets these variables whatever the caller
 * asked for, so a model cannot shadow the facts the harness reports.
 */
export const MANAGED_ENV_PREFIX = 'JZH_'

/** A managed name is the reserved prefix plus an upper-case shell identifier. */
const MANAGED_ENV_NAME = /^JZH_[A-Z][A-Z0-9_]*$/

/** Names the harness owns, mapped to the values it puts in every child. */
export type ManagedEnv = Readonly<Record<string, string>>

/** Names only, never values: a log line is safe to keep and show. */
export const managedNamesOf = (environment: NodeJS.ProcessEnv): ReadonlyArray<string> =>
  Object.keys(environment)
    .filter((name) => name.startsWith(MANAGED_ENV_PREFIX))
    .sort()

/**
 * Writes the managed names before a child starts. Values are deliberately left
 * out: a value may be a credential even though the registry is not the secrets
 * path.
 */
export const logManagedEnv = (
  environment: NodeJS.ProcessEnv,
  write: (line: string) => void = (line) => void process.stderr.write(line + '\n'),
): void => {
  const names = managedNamesOf(environment)
  if (names.length > 0) write('[managed env] ' + names.join(', '))
}

/**
 * The environment of a child. Ambient JZH_* values are dropped first, then the
 * caller's map is applied, and the managed map is applied last so a model that
 * passes a same-named variable cannot replace the harness value.
 */
export const childEnvironment = (
  managed: ManagedEnv,
  requested: ManagedEnv = {},
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(MANAGED_ENV_PREFIX)) environment[name] = value
  }
  return { ...environment, ...requested, ...managed }
}

/**
 * Validates one profile's env map. A name outside the reserved prefix, or one
 * that a shell would split, is a configuration error rather than a variable.
 */
export const managedEnv = (entries: Readonly<Record<string, unknown>>): ManagedEnv => {
  const accepted: Record<string, string> = {}
  for (const [name, value] of Object.entries(entries)) {
    if (!MANAGED_ENV_NAME.test(name)) {
      throw new Error(
        'managed environment names must start with ' +
          MANAGED_ENV_PREFIX +
          ' and hold no "=" or whitespace: ' +
          name,
      )
    }
    if (typeof value !== 'string') {
      throw new Error('the managed environment value of ' + name + ' must be a string')
    }
    accepted[name] = value
  }
  return accepted
}

/** The tier0 row's env setting, or none when the row or the key is absent. */
export const managedEnvOf = (rows: ReadonlyArray<PluginRow>): ManagedEnv => {
  const config = rows.find((row) => row.name === '@jozo-harness/tools-tier0')?.config
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return {}
  const env = (config as { readonly env?: unknown }).env
  if (env === undefined) return {}
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new Error('the tier0 env setting must be a mapping of names to values')
  }
  return managedEnv(env as Readonly<Record<string, unknown>>)
}
