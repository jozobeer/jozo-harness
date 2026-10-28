import type { PluginRow } from '@jozo-harness/kernel'
import { FLAG_NAMES } from './args.ts'
import { CONFIG_HOME_ENV, configPaths } from './config.ts'
import type { JozoHarnessConfig } from './config-file.ts'
import type { CredentialSource, Resolved, SettingsSurface } from './settings.ts'
import { DEEPSEEK_KEY_ENV, EXA_KEY_ENV, PERPLEXITY_KEY_ENV, SEARCH_KEY_ENV } from './search-env.ts'

/** Row keys the command reads from a row's config itself; no plugin declares them. */
export const MODEL_KEY = 'model'
export const EFFORT_KEY = 'effort'
export const SPILL_TOKENS_KEY = 'maxSpillTokens'
export const PLAN_MODE_KEY = 'planMode'

interface RowKeyNote {
  readonly name: string
  readonly where: string
  readonly summary: string
}

export const ROW_KEYS: ReadonlyArray<RowKeyNote> = [
  {
    name: MODEL_KEY,
    where: 'any row',
    summary: 'the route to use when --model and the settings file set none',
  },
  {
    name: EFFORT_KEY,
    where: 'any row',
    summary: 'the reasoning effort to ask the provider for',
  },
  {
    name: SPILL_TOKENS_KEY,
    where: 'any row',
    summary: 'tool output above this many estimated tokens keeps only its ends',
  },
  {
    name: PLAN_MODE_KEY,
    where: 'the @jozo-harness/safety row',
    summary: 'true hides the tools that change the workspace',
  },
]

interface SettingsNote {
  readonly name: string
  /** What the key takes, for a reader deciding whether to write it. */
  readonly summary: string
  /** What the settings file holds now, so the dump shows the state. */
  readonly value: (settings: JozoHarnessConfig | undefined) => string
  /** Lines `jzh config init` comments out as the starting point for this key. */
  readonly example: ReadonlyArray<string>
  /** What the key holds item by item; a count alone does not say which ones. */
  readonly items?: (settings: JozoHarnessConfig | undefined) => ReadonlyArray<string>
}

const countText = (count: number, noun: string, plural: string): string =>
  String(count) + ' ' + (count === 1 ? noun : plural)

const countOr = (
  fallback: string,
  count: number | undefined,
  noun: string,
  plural: string,
): string => (count === undefined ? fallback : countText(count, noun, plural))

/** The row's config and whether it is switched off, as one trailing note. */
const rowNote = (row: PluginRow): string => {
  const config = row.config
  const keys =
    typeof config === 'object' && config !== null && !Array.isArray(config)
      ? Object.entries(config as Record<string, unknown>).map(
          ([key, value]) =>
            key + ': ' + (typeof value === 'string' ? value : JSON.stringify(value)),
        )
      : []
  const parts = row.disabled === true ? ['disabled', ...keys] : keys
  return parts.length === 0 ? '' : ' (' + parts.join(', ') + ')'
}

const rowText = (row: PluginRow): string => row.id + ' → ' + row.name + rowNote(row)

export const SETTINGS_KEYS: ReadonlyArray<SettingsNote> = [
  {
    name: 'model',
    summary: 'provider/model',
    value: (settings) => settings?.model ?? 'not set',
    example: ['model: ollama-cloud/deepseek-v4.1-flash'],
  },
  {
    name: 'effort',
    summary: 'the reasoning effort to ask the provider for; --effort wins over it',
    value: (settings) => settings?.effort ?? 'not set, so the provider chooses',
    example: ['effort: high'],
  },
  {
    name: 'profile',
    summary: 'a bundled profile name; --profile wins over it',
    value: (settings) => settings?.profile ?? 'not set, so headless is used',
    example: ['profile: headless'],
  },
  {
    name: 'port',
    summary: 'the port jzh web listens on; --port wins over it, and 0 asks for a free one',
    value: (settings) =>
      settings?.port === undefined
        ? 'not set, so the system picks a free port'
        : String(settings.port),
    example: ['port: 4310'],
  },
  {
    name: 'search',
    summary:
      'the web_search provider: brave (default when BRAVE_API_KEY is set), deepseek, exa, or perplexity',
    value: (settings) => settings?.search ?? 'not set, so brave when BRAVE_API_KEY is set',
    example: ['search: deepseek'],
  },
  {
    name: 'deepseekToolsBaseUrl',
    summary: 'the DeepSeek Search / Fetch API base; /search and /fetch are appended',
    value: (settings) =>
      settings?.deepseekToolsBaseUrl ?? 'not set, so https://api.deepseek.com/v1/tools',
    example: ['deepseekToolsBaseUrl: https://api.deepseek.com/v1/tools'],
  },
  {
    name: 'skills',
    summary: 'directories that hold <name>/SKILL.md',
    value: (settings) =>
      countOr(
        'not set, so the skill tool is off',
        settings?.skills?.length,
        'directory',
        'directories',
      ),
    example: ['skills:', '  - ~/skills'],
    items: (settings) => settings?.skills ?? [],
  },
  {
    name: 'plugins',
    summary: 'rows merged by id, between the profile and --patch',
    value: (settings) => countOr('not set', settings?.plugins?.length, 'row', 'rows'),
    example: [
      'plugins:',
      '  - id: safety',
      "    name: '@jozo-harness/safety'",
      '    config:',
      '      preset: workspace-write',
    ],
    items: (settings) => (settings?.plugins ?? []).map(rowText),
  },
]

/** The route and effort the command resolved, and the layers each looked through. */
export const renderModelInEffect = (route: string, effort: string): string =>
  (route === ''
    ? 'model in effect: none; a run stops with "no model is set"\n'
    : 'model in effect: ' + route + ' (--model > the settings file > a plugin row)\n') +
  (effort === ''
    ? "effort in effect: the provider's default (--effort > the settings file > a plugin row)\n"
    : 'effort in effect: ' + effort + ' (--effort > the settings file > a plugin row)\n')

/** The keys no plugin schema declares. */
export const renderRowKeys = (): string =>
  [
    'row keys the command reads itself (no plugin declares these):',
    ...ROW_KEYS.map((key) => '  - ' + key.name + ' (' + key.where + '): ' + key.summary),
  ].join('\n') + '\n'

/** The settings file named, with each key, what it holds now, and what is in it. */
export const renderSettings = (path: string, settings: JozoHarnessConfig | undefined): string =>
  [
    'settings (' + path + '):',
    ...SETTINGS_KEYS.flatMap((key) => [
      '  - ' + key.name + ': ' + key.value(settings) + ' — ' + key.summary,
      ...(key.items?.(settings) ?? []).map((item) => '      ' + item),
    ]),
  ].join('\n') + '\n'

const renderFlags = (): string =>
  ['flags (jzh --help shows how they are used):', '  - ' + FLAG_NAMES.join(' ')].join('\n') + '\n'

const renderEnvironment = (): string =>
  [
    "environment and credentials (the shell wins, then the nearest .env, then secrets.env, then a row's apiKeyRef):",
    '  - ' +
      CONFIG_HOME_ENV +
      ': moves the directory that holds config.yaml, secrets.env, and credentials.json',
    '  - ' + SEARCH_KEY_ENV + ': with it the default web_search provider is registered',
    '  - ' + DEEPSEEK_KEY_ENV + ': the key search: deepseek sends to the Search API',
    '  - ' + EXA_KEY_ENV + ': the key search: exa sends to api.exa.ai/search',
    '  - ' + PERPLEXITY_KEY_ENV + ': the key search: perplexity sends to api.perplexity.ai',
  ].join('\n') + '\n'

const describeValue = (value: unknown): string =>
  Array.isArray(value)
    ? String(value.length) + (value.length === 1 ? ' item' : ' items')
    : value === ''
      ? 'not set'
      : String(value)

interface CredentialLine {
  readonly name: string
  readonly source: CredentialSource | undefined
  /** The reference the row names, when it names one. */
  readonly ref?: string | undefined
  /** The credentials store the reference points into. */
  readonly store?: string | undefined
}

const referenceText = (credential: CredentialLine): string =>
  credential.ref === undefined
    ? ''
    : 'the reference "' + credential.ref + '" in ' + (credential.store ?? 'the credentials store')

const sourceWhere = (source: Exclude<CredentialSource, 'credentials'>): string =>
  source === 'environment' ? 'the shell' : source === 'dotenv' ? 'the nearest .env' : 'secrets.env'

const credentialLine = (credential: CredentialLine): string => {
  const reference = referenceText(credential)
  if (credential.source === 'credentials') {
    return '  - ' + credential.name + ': credentials (' + reference + ')'
  }
  if (credential.source === undefined) {
    return credential.ref === undefined
      ? '  - ' + credential.name + ': not set, and the profile asks for it'
      : '  - ' + credential.name + ': not set; ' + reference + ' has no value'
  }
  return (
    '  - ' +
    credential.name +
    ': ' +
    credential.source +
    ' (' +
    sourceWhere(credential.source) +
    ')'
  )
}

/** What a run from here would resolve, and where each value came from. */
export const renderEffective = (
  surface: SettingsSurface | undefined,
  credential: CredentialLine | undefined,
): string => {
  if (surface === undefined) return ''
  const { effective } = surface
  const setting = (name: string, resolved: Resolved<unknown>): string =>
    '  - ' +
    name +
    ': ' +
    describeValue(resolved.value) +
    ' — ' +
    resolved.source +
    ' (' +
    resolved.from +
    ')'
  return (
    [
      'in effect for a run from here:',
      setting('profile', effective.profile),
      setting('route', effective.route),
      setting('effort', effective.effort),
      setting('port', effective.port),
      setting('skills', effective.skills),
      setting('plugins', effective.plugins),
      ...(credential === undefined ? [] : [credentialLine(credential)]),
    ].join('\n') + '\n'
  )
}

/** What `--dump-config` prints after the rows: where the rest is set and what it holds. */
export const renderSurface = (
  settingsPath: string | undefined,
  settings: JozoHarnessConfig | undefined,
): string =>
  renderRowKeys() +
  renderSettings(settingsPath ?? configPaths().config, settings) +
  renderFlags() +
  renderEnvironment()
