import { loadBundledProfile, loadBundledProfileNamed } from '@jozo-harness/bundle-base'
import { mergeRows, parseProfile, type Plugin, type PluginRow } from '@jozo-harness/kernel'
import { parse, stringify } from 'yaml'
import { Effect, Schema } from 'effect'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic-write.ts'
import { configPaths, type ConfigPaths } from './config.ts'
import { loadConfigFile } from './config-file.ts'
import { bundledPlugins } from './plugins.ts'
import { applyEdit, blockText, type EditError, type SettingsEdit } from './settings-edit.ts'
import { SETTINGS_KEYS, renderSettings } from './surface.ts'

export interface ConfigIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const USAGE =
  'jzh config                       the settings file, its keys, and their values\n' +
  'jzh config set K V               write one value (model, effort, profile, port, tools, plugins.<id>.<key>)\n' +
  'jzh config add skills <dir>      add a directory the skill tool reads\n' +
  'jzh config add plugins <name>    add a plugin row (--id names the row)\n' +
  'jzh config remove skills <dir>   drop a directory\n' +
  'jzh config remove plugins <id>   drop a plugin row\n' +
  'jzh config init                  write a starting file with every key commented out\n'

/** The keys a person writes as one value; the list keys have their own commands. */
const SCALAR_KEYS: ReadonlyArray<string> = [
  'model',
  'effort',
  'profile',
  'port',
  'search',
  'deepseekToolsBaseUrl',
]

/** Keys the file holds as numbers, so an edit writes 4310 rather than '4310'. */
const NUMBER_KEYS: ReadonlyArray<string> = ['port']
/**
 * Keys whose value is one line of comma-separated names. `tools` is the default
 * composition of a new session, so a page and a human write the same key.
 */
const LIST_VALUE_KEYS: ReadonlyArray<string> = ['tools']
const LIST_KEYS: ReadonlyArray<string> = ['skills']
const KNOWN_KEYS: ReadonlyArray<string> = SETTINGS_KEYS.map((note) => note.name)

const GUIDE = [
  'change a value   jzh config set model <provider/model>\n' +
    '                  jzh config set effort <level>\n',
  'add a directory  jzh config add skills <dir>\n',
  'add a plugin     jzh config add plugins <name>\n',
  'list models      jzh models\n',
  'secrets          jzh auth add ollama\n',
  'every key        jzh --dump-config\n',
]

const template = (): string =>
  [
    '# jozo-harness settings. Every key is commented out; remove the # to use one.',
    '# jzh config shows what is in effect, jzh --dump-config shows every key.',
    '',
    ...SETTINGS_KEYS.flatMap((note) => [
      '# ' + note.name + ': ' + note.summary,
      ...note.example.map((line) => '# ' + line),
      '',
    ]),
  ].join('\n')

const said = (io: ConfigIo, text: string): number => {
  io.stdout(text.endsWith('\n') ? text : text + '\n')
  return 0
}

const refused = (io: ConfigIo, message: string): number => {
  io.stderr('jzh: ' + message + '\n')
  return 2
}

const usage = (io: ConfigIo): number => {
  io.stderr(USAGE)
  return 2
}

const indented = (text: string): string =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => '  ' + line)
    .join('\n')

const settingsOf = async (paths: ConfigPaths) =>
  await Effect.runPromise(Effect.result(loadConfigFile(paths.config)))

const modelProblem = (value: string): string | undefined => {
  const parts = value.split('/')
  const shaped = parts.length === 2 && parts.every((part) => part !== '' && !/\s/.test(part))
  return shaped ? undefined : 'model takes provider/model (jzh models lists them)'
}

const SEARCH_PROVIDERS: ReadonlyArray<string> = ['brave', 'deepseek', 'exa', 'perplexity']

const searchProblem = (value: string): string | undefined =>
  SEARCH_PROVIDERS.includes(value) ? undefined : 'search takes brave, deepseek, exa, or perplexity'

const baseUrlProblem = (value: string): string | undefined =>
  /^https?:\/\//.test(value) ? undefined : 'deepseekToolsBaseUrl takes an http(s) URL'

/** A bare decimal from 0 to 65535; the file writes it as a YAML number. */
const portProblem = (value: string): string | undefined => {
  const port = Number(value)
  return /^\d+$/.test(value) && port <= 65535
    ? undefined
    : 'port takes a whole number between 0 and 65535'
}

/** The scalar keys whose value the settings file can check without asking a provider. */
const SCALAR_PROBLEMS: Readonly<Record<string, (value: string) => string | undefined>> = {
  model: modelProblem,
  // Which words an endpoint takes is the endpoint's to say, so the file takes any of them.
  effort: () => undefined,
  port: portProblem,
  search: searchProblem,
  deepseekToolsBaseUrl: baseUrlProblem,
}

/** Why the value does not fit the key; undefined when it does. */
const refusal = async (key: string, value: string): Promise<string | undefined> => {
  const known = SCALAR_PROBLEMS[key]
  if (known !== undefined) return known(value)
  return await loadBundledProfileNamed(value).then(
    () => undefined,
    () => 'no bundled profile named ' + value + ' (base, headless, repl)',
  )
}

const editProblem = (error: EditError, paths: ConfigPaths): string => {
  switch (error.code) {
    case 'inline-value':
      return error.about + ' is written on one line in ' + paths.config + '; edit it there'
    case 'no-such-item':
      return 'no such directory ' + error.about + ' in ' + paths.config + ' (jzh config shows it)'
    case 'no-such-row':
      return 'no row ' + error.about + ' in ' + paths.config
    case 'duplicate-row':
      return (
        paths.config +
        ' already has the row ' +
        error.about +
        '; jzh config set plugins.' +
        error.about +
        '.<key> <value> writes a key'
      )
  }
}

const settingsText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')

const saved = (io: ConfigIo, paths: ConfigPaths, text: string): number | undefined => {
  try {
    writeFileAtomic(paths.config, text)
    return undefined
  } catch (cause) {
    io.stderr('jzh: cannot write ' + paths.config + ': ' + String(cause) + '\n')
    return 1
  }
}

interface Report {
  readonly io: ConfigIo
  readonly paths: ConfigPaths
  readonly edit: SettingsEdit
  /** The block the result prints after the sentence. */
  readonly key: string
  /** What to say when the file already holds exactly this. */
  readonly unchanged: string
  readonly changed: (block: string) => string
}

/** Applies one edit, writes it when it changed something, and says what happened. */
const applyAndReport = async (report: Report): Promise<number> => {
  const done = await Effect.runPromise(
    Effect.result(applyEdit(settingsText(report.paths.config), report.edit)),
  )
  if (done._tag === 'Failure') return refused(report.io, editProblem(done.failure, report.paths))
  if (!done.success.changed) return said(report.io, 'jzh: ' + report.unchanged)
  const failure = saved(report.io, report.paths, done.success.text)
  if (failure !== undefined) return failure
  const block = indented(blockText(done.success.text, report.key))
  return said(report.io, 'jzh: ' + report.changed(block))
}

const show = async (io: ConfigIo, paths: ConfigPaths): Promise<number> => {
  const loaded = await settingsOf(paths)
  if (loaded._tag === 'Failure') {
    io.stderr('jzh: ' + loaded.failure.message + '\n')
    return 1
  }
  io.stdout(renderSettings(paths.config, loaded.success))
  if (!existsSync(paths.config)) {
    io.stdout('(no file yet; jzh config init writes a starting one)\n')
  }
  io.stdout('\n' + GUIDE.join(''))
  return 0
}

/** The rows the bundled profile provides, which a settings row can override. */
const profileRows = async (): Promise<ReadonlyArray<PluginRow>> => {
  const text = await loadBundledProfile()
  const profile = await Effect.runPromise(parseProfile(text))
  return profile.plugins
}

const configFields = (plugin: Plugin<any, any, any>): Record<string, Schema.Schema<any>> =>
  (plugin.config as { readonly fields?: Record<string, Schema.Schema<any>> }).fields ?? {}

const pluginNamed = (name: string): Plugin<any, any, any> | undefined =>
  bundledPlugins.find((plugin) => plugin.name === name)

type ParsedYaml = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

const parseYaml = (raw: string): ParsedYaml => {
  try {
    return { ok: true, value: parse(raw) }
  } catch {
    return { ok: false }
  }
}

type Checked =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problem: string }

/** One key's schema applied to one value; the message is all the caller reads. */
const decodeField = (
  field: Schema.Schema<any>,
  value: unknown,
): Effect.Effect<any, { readonly message: string }, never> =>
  Schema.decodeUnknownEffect(field)(value).pipe(
    Effect.mapError((issue) => issue as { readonly message: string }),
  ) as Effect.Effect<any, { readonly message: string }, never>

/** The one-line YAML text of a value, or why the plugin's schema refuses it. */
const checkedConfig = async (
  plugin: Plugin<any, any, any>,
  id: string,
  key: string,
  raw: string,
): Promise<Checked> => {
  const fields = configFields(plugin)
  const field = fields[key]
  if (field === undefined) {
    const takes = Object.keys(fields)
    return {
      ok: false,
      problem:
        plugin.name +
        ' has no key ' +
        key +
        ' (row ' +
        id +
        '); it takes ' +
        (takes.length === 0 ? 'none' : takes.join(', ')),
    }
  }
  const parsed = parseYaml(raw)
  if (!parsed.ok) return { ok: false, problem: 'the value of ' + key + ' is not YAML: ' + raw }
  const decoded = await Effect.runPromise(Effect.result(decodeField(field, parsed.value)))
  if (decoded._tag === 'Failure') {
    return { ok: false, problem: key + ' does not take ' + raw + ': ' + decoded.failure.message }
  }
  // The value goes after `key:` on one line, so collections are written in flow style.
  const text = stringify(parsed.value, { collectionStyle: 'flow' }).trim()
  return text.includes('\n')
    ? { ok: false, problem: 'the value of ' + key + ' must fit on one line' }
    : { ok: true, text }
}

const checkedDisabled = (raw: string): Checked => {
  const parsed = parseYaml(raw)
  return parsed.ok && typeof parsed.value === 'boolean'
    ? { ok: true, text: String(parsed.value) }
    : { ok: false, problem: 'disabled takes true or false' }
}

/** The row and key `plugins.<id>.<key>` names. */
interface Target {
  readonly id: string
  readonly key: string
}

const targetOf = (address: string): Target | undefined => {
  const parts = address.split('.')
  const [, id = '', key = ''] = parts
  const shaped = parts.length === 3 && parts[0] === 'plugins' && id !== '' && key !== ''
  return shaped ? { id, key } : undefined
}

type Found =
  | { readonly ok: true; readonly row: PluginRow }
  | { readonly ok: false; readonly problem: string }

/** The row the profile or the settings file provides, by id. */
const rowInEffect = async (paths: ConfigPaths, id: string): Promise<Found> => {
  const loaded = await settingsOf(paths)
  if (loaded._tag === 'Failure') return { ok: false, problem: loaded.failure.message }
  const rows = mergeRows([await profileRows(), loaded.success.plugins ?? []])
  const row = rows.find((candidate) => candidate.id === id)
  return row === undefined
    ? {
        ok: false,
        problem:
          'no row ' +
          id +
          ' in the base profile or ' +
          paths.config +
          '; jzh config add plugins <name> adds one',
      }
    : { ok: true, row }
}

const checkedRowValue = async (
  plugin: Plugin<any, any, any>,
  target: Target,
  raw: string,
): Promise<Checked> =>
  target.key === 'disabled'
    ? checkedDisabled(raw)
    : await checkedConfig(plugin, target.id, target.key, raw)

const setRowValue = async (
  address: string,
  raw: string,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const target = targetOf(address)
  if (target === undefined) return usage(io)
  const found = await rowInEffect(paths, target.id)
  if (!found.ok) return refused(io, found.problem)
  const plugin = pluginNamed(found.row.name)
  if (plugin === undefined) {
    return refused(
      io,
      'row ' + target.id + ' is ' + found.row.name + ', which this build does not have',
    )
  }
  const checked = await checkedRowValue(plugin, target, raw)
  if (!checked.ok) return refused(io, checked.problem)
  return await applyAndReport({
    io,
    paths,
    edit: {
      kind: 'set-row',
      id: target.id,
      name: found.row.name,
      key: target.key,
      value: checked.text,
    },
    key: 'plugins',
    unchanged:
      target.key + ' of row ' + target.id + ' is already ' + checked.text + ' in ' + paths.config,
    changed: (block) =>
      'wrote plugins.' + target.id + '.' + target.key + ' in ' + paths.config + '\n' + block,
  })
}

/** Writes a key whose value is one comma-separated list, such as the default tools. */
const setListValue = async (
  key: string,
  value: string,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (items.length === 0) return refused(io, key + ' needs at least one name')
  return await applyAndReport({
    io,
    paths,
    edit: { kind: 'set-list', key, items },
    key,
    unchanged: key + ' is already ' + items.join(', ') + ' in ' + paths.config,
    changed: (block) => 'wrote ' + key + ' in ' + paths.config + '\n' + block,
  })
}

/** Writes one scalar key, refusing a key or a value the file does not take. */
const setScalarValue = async (
  key: string,
  value: string,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  if (LIST_KEYS.includes(key)) {
    return refused(io, key + ' holds a list; jzh config add ' + key + ' <dir>')
  }
  if (!SCALAR_KEYS.includes(key)) {
    return refused(io, 'the settings file takes ' + KNOWN_KEYS.join(', '))
  }
  const problem = await refusal(key, value)
  if (problem !== undefined) return refused(io, problem)
  const scalarValue: string | number = NUMBER_KEYS.includes(key) ? Number(value) : value
  return await applyAndReport({
    io,
    paths,
    edit: { kind: 'set-scalar', key, value: scalarValue },
    key,
    unchanged: key + ' is already ' + value + ' in ' + paths.config,
    changed: (block) => 'wrote ' + key + ' in ' + paths.config + '\n' + block,
  })
}

const setValue = async (
  argv: ReadonlyArray<string>,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const [key = '', value = ''] = argv
  if (key === '' || value === '') return usage(io)
  if (key.startsWith('plugins.')) return await setRowValue(key, value, io, paths)
  if (LIST_VALUE_KEYS.includes(key)) return await setListValue(key, value, io, paths)
  return await setScalarValue(key, value, io, paths)
}

/** `~` is the shell's, not YAML's, so the check expands it the way a shell would. */
const resolved = (dir: string): string =>
  dir === '~' ? homedir() : dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir

const isDirectory = (dir: string): boolean => {
  try {
    return statSync(resolved(dir)).isDirectory()
  } catch {
    return false
  }
}

const addSkill = async (
  argv: ReadonlyArray<string>,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const [dir = ''] = argv
  if (dir === '') return usage(io)
  if (!isDirectory(dir)) return refused(io, dir + ' is not a directory')
  return await applyAndReport({
    io,
    paths,
    edit: { kind: 'add-skill', dir },
    key: 'skills',
    unchanged: dir + ' is already in skills',
    changed: (block) => 'added ' + dir + ' in ' + paths.config + '\n' + block,
  })
}

const removeSkill = async (
  argv: ReadonlyArray<string>,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const [dir = ''] = argv
  if (dir === '') return usage(io)
  return await applyAndReport({
    io,
    paths,
    edit: { kind: 'remove-skill', dir },
    key: 'skills',
    unchanged: 'no ' + dir + ' in skills',
    changed: (block) => 'removed ' + dir + ' from skills\n' + block,
  })
}

/** The row id for a plugin name the profile does not already name: @jozo-harness/mcp -> mcp. */
const derivedId = (name: string): string =>
  name.includes('/') ? name.slice(name.indexOf('/') + 1) : name

const flagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

const addRow = async (
  argv: ReadonlyArray<string>,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const [name = '', ...flags] = argv
  if (name === '') return usage(io)
  const id = flagValue(flags, '--id')
  if (flags.length > 0 && (flags.length !== 2 || id === undefined || flags[0] !== '--id')) {
    return usage(io)
  }
  const plugin = pluginNamed(name)
  if (plugin === undefined) {
    const known = bundledPlugins.map((one) => one.name).join(', ')
    return refused(io, 'unknown plugin ' + name + '; this build has ' + known)
  }
  const provided = (await profileRows()).find((row) => row.name === name)
  if (provided !== undefined) {
    return refused(
      io,
      'the profile provides ' +
        name +
        ' as row ' +
        provided.id +
        '; jzh config set plugins.' +
        provided.id +
        '.<key> <value> overrides a key',
    )
  }
  const row = id ?? derivedId(name)
  return await applyAndReport({
    io,
    paths,
    edit: { kind: 'add-row', id: row, name },
    key: 'plugins',
    unchanged: 'the row ' + row + ' is already in ' + paths.config,
    changed: (block) => 'added the row ' + row + ' in ' + paths.config + '\n' + block,
  })
}

const removeRow = async (
  argv: ReadonlyArray<string>,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const [id = ''] = argv
  if (id === '') return usage(io)
  const loaded = await settingsOf(paths)
  if (loaded._tag === 'Failure') return refused(io, loaded.failure.message)
  if (!(loaded.success.plugins ?? []).some((row) => row.id === id)) {
    const provided = (await profileRows()).find((row) => row.id === id)
    return refused(
      io,
      provided === undefined
        ? 'no row ' + id + ' in ' + paths.config
        : 'no row ' +
            id +
            ' in ' +
            paths.config +
            ' (the profile provides it; jzh config set plugins.' +
            id +
            '.<key> <value> overrides a key)',
    )
  }
  return await applyAndReport({
    io,
    paths,
    edit: { kind: 'remove-row', id },
    key: 'plugins',
    unchanged: 'no row ' + id + ' in ' + paths.config,
    changed: (block) => 'removed the row ' + id + ' from ' + paths.config + '\n' + block,
  })
}

const init = async (io: ConfigIo, paths: ConfigPaths): Promise<number> => {
  if (existsSync(paths.config)) {
    io.stderr('jzh: ' + paths.config + ' already exists; jzh config shows what it holds\n')
    return 1
  }
  try {
    writeFileAtomic(paths.config, template())
  } catch (cause) {
    io.stderr('jzh: cannot write ' + paths.config + ': ' + String(cause) + '\n')
    return 1
  }
  io.stdout('jzh: wrote a starting file at ' + paths.config + '\n')
  return 0
}

/** The `jzh config` subcommand: show the settings, write one, or start a file. */
export async function runConfig(
  argv: ReadonlyArray<string>,
  io: ConfigIo,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const paths = configPaths(env)
  const [command, ...rest] = argv
  if (command === undefined) return await show(io, paths)
  if (command === 'set') return await setValue(rest, io, paths)
  if (command === 'add') return await addValue(rest, io, paths)
  if (command === 'remove') return await removeValue(rest, io, paths)
  if (command === 'init') return await init(io, paths)
  if (command === 'help' || command === '--help') return said(io, USAGE)
  return usage(io)
}

const addValue = async (
  argv: ReadonlyArray<string>,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const [what = '', ...rest] = argv
  if (what === 'skills') return await addSkill(rest, io, paths)
  if (what === 'plugins') return await addRow(rest, io, paths)
  return usage(io)
}

const removeValue = async (
  argv: ReadonlyArray<string>,
  io: ConfigIo,
  paths: ConfigPaths,
): Promise<number> => {
  const [what = '', ...rest] = argv
  if (what === 'skills') return await removeSkill(rest, io, paths)
  if (what === 'plugins') return await removeRow(rest, io, paths)
  return usage(io)
}
