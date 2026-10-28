import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from '@jozo-harness/agent-loop'
import { isRowEnabled, type PluginRow } from '@jozo-harness/kernel'
import { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS } from '@jozo-harness/tools-tier0'
import { DELEGATION_MAX_DEPTH } from '@jozo-harness/tools-tier1'
import type { EditableSettingsView, RunSettingsInput, SearchProvider } from '@jozo-harness/web'
import { Effect } from 'effect'
import { stringify } from 'yaml'
import { hasCredential } from './credentials.ts'
import type { JozoHarnessConfig } from './config-file.ts'
import { applyEdit, type EditError, type SettingsEdit } from './settings-edit.ts'

/** The row names the editable values live under, in the base profile. */
const TIER0 = '@jozo-harness/tools-tier0'
const TIER1 = '@jozo-harness/tools-tier1'
const AGENT_LOOP = '@jozo-harness/agent-loop'
const LLM = '@jozo-harness/llm-openai'
const DELEGATE = '@jozo-harness/delegate'

/** The variable each provider reads, named even when it is missing. */
export const SEARCH_KEY_OF: Readonly<Record<SearchProvider, string>> = {
  brave: 'BRAVE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  exa: 'EXA_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
}

/** The row id a new delegate row gets; the base profile has none to merge with. */
export const DELEGATE_ROW_ID = 'delegate'

/** The numbers the settings file may hold for the three limits. */
export const LIMIT_BOUNDS = {
  bashTimeoutMs: { minimum: 1, maximum: BASH_MAX_TIMEOUT_MS },
  maxParallelToolCalls: { minimum: 1, maximum: 64 },
  subagentDepth: { minimum: 0, maximum: 8 },
} as const

const DEFAULTS = {
  bashTimeoutMs: BASH_DEFAULT_TIMEOUT_MS,
  maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  subagentDepth: DELEGATION_MAX_DEPTH,
} as const

const enabled = (rows: ReadonlyArray<PluginRow>, name: string): PluginRow | undefined =>
  rows.find((row) => row.name === name && isRowEnabled(row))

const configOf = (row: PluginRow | undefined): Readonly<Record<string, unknown>> => {
  const config = row?.config
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? (config as Readonly<Record<string, unknown>>)
    : {}
}

const settingsRowOf = (settings: JozoHarnessConfig, name: string): PluginRow | undefined =>
  (settings.plugins ?? []).find((row) => row.name === name)

const settingsHas = (settings: JozoHarnessConfig, name: string, key: string): boolean => {
  const row = settingsRowOf(settings, name)
  return row !== undefined && Object.hasOwn(configOf(row), key)
}

const sourceOf = (
  settings: JozoHarnessConfig,
  path: string,
  name: string,
  key: string,
  row: PluginRow | undefined,
  fallback: string,
): string => {
  if (settingsHas(settings, name, key)) return path
  return row !== undefined && Object.hasOwn(configOf(row), key)
    ? 'the ' + row.name + ' row'
    : fallback
}

const numberIn = (
  config: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number => {
  const value = config[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

const toolsOf = (
  row: PluginRow | undefined,
): ReadonlyArray<RunSettingsInput['delegateTools'][number]> => {
  // A malformed row already failed the start, so only the shape a row can hold is read.
  const value = configOf(row)['tools']
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const name = (item as { readonly name?: unknown }).name
    const argv = (item as { readonly argv?: unknown }).argv
    if (typeof name !== 'string' || !Array.isArray(argv)) return []
    const words = argv.filter((word): word is string => typeof word === 'string')
    return words.length === argv.length ? [{ name, argv: words }] : []
  })
}

/** How the run reads the editable values right now, and where each came from. */
export interface EditableInputs {
  readonly rows: ReadonlyArray<PluginRow>
  /** The settings file as the run loaded it. */
  readonly settings: JozoHarnessConfig
  readonly settingsPath: string
  /** The environment after .env and secrets.env were loaded. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly credentialsPath: string
}

const providerOf = (
  settings: JozoHarnessConfig,
  env: Readonly<Record<string, string | undefined>>,
): SearchProvider | undefined => {
  if (settings.search !== undefined) return settings.search
  return (env['BRAVE_API_KEY'] ?? '') === '' ? undefined : 'brave'
}

const limitView = (
  inputs: EditableInputs,
  name: string,
  key: string,
  fallback: number,
): EditableSettingsView['bashTimeoutMs'] => {
  const row = enabled(inputs.rows, name)
  return {
    value: numberIn(configOf(row), key, fallback),
    source: sourceOf(inputs.settings, inputs.settingsPath, name, key, row, 'the default'),
  }
}

const searchView = (inputs: EditableInputs): EditableSettingsView['search'] => {
  const provider = providerOf(inputs.settings, inputs.env)
  const keyName = provider === undefined ? '' : SEARCH_KEY_OF[provider]
  return {
    ...(provider === undefined ? {} : { provider }),
    keyName,
    keyPresent: keyName !== '' && (inputs.env[keyName] ?? '') !== '',
    source:
      inputs.settings.search !== undefined
        ? inputs.settingsPath
        : provider === undefined
          ? 'no provider is named and no search key is present'
          : 'BRAVE_API_KEY in the environment',
  }
}

const keyRefView = (inputs: EditableInputs): EditableSettingsView['apiKeyRef'] => {
  const row = enabled(inputs.rows, LLM)
  const asked = configOf(row)['apiKeyRef']
  const ref = typeof asked === 'string' ? asked : ''
  return {
    ref,
    present: ref !== '' && hasCredential(inputs.credentialsPath, ref),
    source: sourceOf(
      inputs.settings,
      inputs.settingsPath,
      LLM,
      'apiKeyRef',
      row,
      'no reference is named',
    ),
  }
}

/** Reads every editable value the way the run in effect reads it, without a secret. */
export const readEditableSettings = (inputs: EditableInputs): EditableSettingsView => ({
  search: searchView(inputs),
  apiKeyRef: keyRefView(inputs),
  bashTimeoutMs: limitView(inputs, TIER0, 'timeoutMs', DEFAULTS.bashTimeoutMs),
  maxParallelToolCalls: limitView(
    inputs,
    AGENT_LOOP,
    'maxParallelToolCalls',
    DEFAULTS.maxParallelToolCalls,
  ),
  subagentDepth: limitView(inputs, TIER1, 'subagentMaxDepth', DEFAULTS.subagentDepth),
  delegateTools: toolsOf(enabled(inputs.rows, DELEGATE)),
})

/** One value a save refused, named so the page can point at the field. */
export interface RunSettingsProblem {
  readonly field: string
  readonly message: string
}

const integerProblem = (
  field: keyof typeof LIMIT_BOUNDS,
  value: number,
): RunSettingsProblem | undefined => {
  const bounds = LIMIT_BOUNDS[field]
  return Number.isInteger(value) && value >= bounds.minimum && value <= bounds.maximum
    ? undefined
    : {
        field,
        message:
          field +
          ' takes a whole number between ' +
          String(bounds.minimum) +
          ' and ' +
          String(bounds.maximum),
      }
}

const SEARCH_PROVIDERS: ReadonlyArray<string> = ['brave', 'deepseek', 'exa', 'perplexity']
const REF = /^[A-Za-z0-9._-]+$/
const TOOL_NAME = /^[A-Za-z0-9._-]+$/

/** Every reason this input would not be saved, in the order the page shows the fields. */
export const runSettingsProblems = (input: RunSettingsInput): ReadonlyArray<RunSettingsProblem> => {
  const problems: Array<RunSettingsProblem> = []
  const add = (problem: RunSettingsProblem | undefined) => {
    if (problem !== undefined) problems.push(problem)
  }
  if (input.search !== '' && !SEARCH_PROVIDERS.includes(input.search)) {
    add({
      field: 'search',
      message: 'search takes brave, deepseek, exa, perplexity, or no provider',
    })
  }
  if (input.apiKeyRef !== '' && !REF.test(input.apiKeyRef)) {
    add({
      field: 'apiKeyRef',
      message: 'apiKeyRef takes letters, digits, dots, dashes, or underscores',
    })
  }
  add(integerProblem('bashTimeoutMs', input.bashTimeoutMs))
  add(integerProblem('maxParallelToolCalls', input.maxParallelToolCalls))
  add(integerProblem('subagentDepth', input.subagentDepth))
  const names = new Set<string>()
  input.delegateTools.forEach((tool, index) => {
    if (!TOOL_NAME.test(tool.name)) {
      add({
        field: 'delegateTools[' + String(index) + '].name',
        message: 'a delegated tool needs a name of letters, digits, dots, dashes, or underscores',
      })
    } else if (names.has(tool.name)) {
      add({
        field: 'delegateTools[' + String(index) + '].name',
        message: 'the delegated tool ' + tool.name + ' is listed twice',
      })
    }
    names.add(tool.name)
    if (tool.argv.length === 0 || tool.argv.some((word) => word === '')) {
      add({
        field: 'delegateTools[' + String(index) + '].argv',
        message: 'a delegated tool needs one or more non-empty argv words',
      })
    }
  })
  return problems
}

const yamlValue = (value: unknown, field: string): string | RunSettingsProblem => {
  const text = stringify(value, { collectionStyle: 'flow' }).trim()
  return text.includes('\n') ? { field, message: field + ' does not fit on one line' } : text
}

const sameTools = (
  left: ReadonlyArray<RunSettingsInput['delegateTools'][number]>,
  right: ReadonlyArray<RunSettingsInput['delegateTools'][number]>,
): boolean => JSON.stringify(left) === JSON.stringify(right)

const editProblem = (error: EditError): RunSettingsProblem => ({
  field: 'settings',
  message:
    error.code === 'inline-value'
      ? 'the settings file writes ' + error.about + ' on one line; edit it there'
      : 'the settings file has no row ' + error.about,
})

const searchEdits = (
  inputs: EditableInputs,
  input: RunSettingsInput,
): ReadonlyArray<SettingsEdit> => {
  if (input.search === '') {
    return inputs.settings.search === undefined ? [] : [{ kind: 'remove-scalar', key: 'search' }]
  }
  return inputs.settings.search === input.search
    ? []
    : [{ kind: 'set-scalar', key: 'search', value: input.search }]
}

const keyRefEdits = (
  inputs: EditableInputs,
  input: RunSettingsInput,
): ReadonlyArray<SettingsEdit> => {
  const row = enabled(inputs.rows, LLM)
  if (row === undefined) return []
  if (input.apiKeyRef === '') {
    return settingsHas(inputs.settings, LLM, 'apiKeyRef')
      ? [{ kind: 'remove-row-key', id: row.id, key: 'apiKeyRef' }]
      : []
  }
  if (configOf(row)['apiKeyRef'] === input.apiKeyRef) return []
  const value = yamlValue(input.apiKeyRef, 'apiKeyRef')
  return typeof value === 'string'
    ? [{ kind: 'set-row', id: row.id, name: row.name, key: 'apiKeyRef', value }]
    : []
}

interface LimitEdit {
  readonly field: keyof typeof LIMIT_BOUNDS
  readonly name: string
  readonly key: string
  readonly value: number
}

const limitEdits = (inputs: EditableInputs, edit: LimitEdit): ReadonlyArray<SettingsEdit> => {
  const row = enabled(inputs.rows, edit.name)
  if (row === undefined) return []
  const current = numberIn(configOf(row), edit.key, DEFAULTS[edit.field])
  if (current === edit.value) return []
  if (edit.value === DEFAULTS[edit.field] && settingsHas(inputs.settings, edit.name, edit.key)) {
    return [{ kind: 'remove-row-key', id: row.id, key: edit.key }]
  }
  return [
    {
      kind: 'set-row',
      id: row.id,
      name: row.name,
      key: edit.key,
      value: String(edit.value),
    },
  ]
}

const limitEditsFor = (
  inputs: EditableInputs,
  input: RunSettingsInput,
): ReadonlyArray<SettingsEdit> => {
  const limits: ReadonlyArray<LimitEdit> = [
    { field: 'bashTimeoutMs', name: TIER0, key: 'timeoutMs', value: input.bashTimeoutMs },
    {
      field: 'maxParallelToolCalls',
      name: AGENT_LOOP,
      key: 'maxParallelToolCalls',
      value: input.maxParallelToolCalls,
    },
    {
      field: 'subagentDepth',
      name: TIER1,
      key: 'subagentMaxDepth',
      value: input.subagentDepth,
    },
  ]
  return limits.flatMap((limit) => limitEdits(inputs, limit))
}

const delegateEdits = (
  inputs: EditableInputs,
  input: RunSettingsInput,
): ReadonlyArray<SettingsEdit> => {
  const effective = enabled(inputs.rows, DELEGATE)
  if (input.delegateTools.length === 0) {
    const row = settingsRowOf(inputs.settings, DELEGATE)
    return row === undefined ? [] : [{ kind: 'remove-row', id: row.id }]
  }
  if (sameTools(toolsOf(effective), input.delegateTools)) return []
  const value = yamlValue(input.delegateTools, 'delegateTools')
  if (typeof value !== 'string') return []
  const row = effective ?? settingsRowOf(inputs.settings, DELEGATE)
  return [
    {
      kind: 'set-row',
      id: row?.id ?? DELEGATE_ROW_ID,
      name: DELEGATE,
      key: 'tools',
      value,
    },
  ]
}

/**
 * The edits one save makes. A value the layer beneath already holds is not written,
 * so the file keeps only the choices that differ from the profile and the defaults.
 */
const editsFor = (inputs: EditableInputs, input: RunSettingsInput): ReadonlyArray<SettingsEdit> => [
  ...searchEdits(inputs, input),
  ...keyRefEdits(inputs, input),
  ...limitEditsFor(inputs, input),
  ...delegateEdits(inputs, input),
]

/**
 * Applies one save to the settings text. Every value the page sent is checked
 * first, so a bad field never leaves a half-written file.
 */
export const editRunSettings = (
  text: string,
  inputs: EditableInputs,
  input: RunSettingsInput,
): Effect.Effect<string, RunSettingsProblem> => {
  return Effect.gen(function* () {
    const problems = runSettingsProblems(input)
    if (problems.length > 0) return yield* Effect.fail(problems[0]!)
    let current = text
    for (const edit of editsFor(inputs, input)) {
      current = (yield* applyEdit(current, edit).pipe(Effect.mapError(editProblem))).text
    }
    return current
  })
}
