import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Effect, type Scope } from 'effect'
import type { SystemPromptShape } from './system-prompt.ts'
import type { PromptError, PromptSection } from './types.ts'

export interface AgentsFile {
  /** Absolute path of the file that was read. */
  readonly path: string
  readonly text: string
}

/** What discovery found, in render order: the outermost file first, the nearest last. */
export interface AgentsLoad {
  readonly files: ReadonlyArray<AgentsFile>
  /** Paths that exist but were not read, because they are larger than the source cap. */
  readonly omitted: ReadonlyArray<string>
}

export const AGENTS_FILE = 'AGENTS.md'
/** Base instruction candidates searched in every directory, in order. */
export const AGENTS_MD_NAMES: ReadonlyArray<string> = ['AGENTS.md', 'CLAUDE.md']
/** Local overlays, searched after the base candidates of the same directory. */
export const AGENTS_MD_LOCAL_NAMES: ReadonlyArray<string> = ['AGENTS.local.md', 'CLAUDE.local.md']
/** Instruction sections sit after every built-in one. */
export const AGENTS_MD_ORDER = 900
/** Every rendered instruction section may spend this many UTF-8 bytes together. */
export const AGENTS_MD_BUDGET_BYTES = 64 * 1024
/** One file larger than this is not read at all. */
export const AGENTS_MD_SOURCE_BYTES = 1024 * 1024
/** Walking upward stops at the first directory that holds this entry. */
export const PROJECT_ROOT_MARKER = '.git'

export interface AgentsMdOptions {
  /** Base file names searched in each directory, in order. Default: `AGENTS.md`, `CLAUDE.md`. */
  readonly names?: ReadonlyArray<string>
  /**
   * Local overlay names searched after the base ones in the same directory.
   * Default: `AGENTS.local.md`, `CLAUDE.local.md`.
   */
  readonly localNames?: ReadonlyArray<string>
  /** A home directory whose instruction file renders before every workspace one. */
  readonly home?: string
  /** Directory entry that marks the project root. '' walks to the filesystem root. */
  readonly rootMarker?: string
  /** UTF-8 byte budget for all rendered sections. */
  readonly maxBytes?: number
  /** Largest instruction file read at all. */
  readonly maxSourceBytes?: number
}

/** What one file the byte budget cut short. */
export interface TruncatedAgentsFile {
  readonly path: string
  readonly originalBytes: number
  readonly includedBytes: number
}

export interface AgentsSections {
  readonly sections: ReadonlyArray<PromptSection>
  /** Names what the byte budget cut, or undefined when every file fit whole. */
  readonly notice?: PromptSection
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

const namesOf = (options: AgentsMdOptions): ReadonlyArray<string> => {
  const names = options.names
  return names === undefined || names.length === 0 ? AGENTS_MD_NAMES : names
}

const localNamesOf = (options: AgentsMdOptions): ReadonlyArray<string> => {
  const names = options.localNames
  return names === undefined || names.length === 0 ? AGENTS_MD_LOCAL_NAMES : names
}

/** Every candidate of one directory in read order: the base names, then the overlays. */
const candidatesOf = (options: AgentsMdOptions): ReadonlyArray<string> => [
  ...namesOf(options),
  ...localNamesOf(options),
]

const pathExists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    stat(path).then(
      () => true,
      () => false,
    ),
  )

interface ReadResult {
  readonly file?: AgentsFile
  /** Set when the path is a file larger than the source cap. */
  readonly tooLarge?: string
}

const readIfPresent = (path: string, maxSourceBytes: number): Effect.Effect<ReadResult> =>
  Effect.gen(function* () {
    const info = yield* Effect.promise(() =>
      stat(path).then(
        (value) => value,
        () => undefined,
      ),
    )
    if (info === undefined) return {}
    if (info.size > maxSourceBytes) return { tooLarge: path }
    return { file: { path, text: yield* Effect.promise(() => readFile(path, 'utf8')) } }
  })

/** The project root: the nearest directory holding the marker, or the filesystem root. */
const projectRootOf = (cwd: string, marker: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (marker === '') return '/'
    let directory = cwd
    while (true) {
      if (yield* pathExists(join(directory, marker))) return directory
      const parent = dirname(directory)
      if (parent === directory) return '/'
      directory = parent
    }
  })

/**
 * The directories to search, outermost first. `root` is included; the walk stops
 * there, so instructions above the project root never reach the model.
 */
const chainFrom = (root: string, cwd: string): ReadonlyArray<string> => {
  const chain: Array<string> = []
  let directory = cwd
  while (true) {
    chain.push(directory)
    if (directory === root) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return chain.reverse()
}

/** True when `path` is `root` itself or sits below it. */
const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : root + '/')

/**
 * Reads the instruction files that apply to `cwd`: the home file first, then one
 * set per directory from the project root down to `cwd`. A file whose trimmed text
 * was already read is skipped, so the same instruction never renders twice.
 */
export function loadAgentsFiles(
  cwd: string,
  options: AgentsMdOptions = {},
): Effect.Effect<AgentsLoad> {
  return Effect.gen(function* () {
    const names = namesOf(options)
    const cap = options.maxSourceBytes ?? AGENTS_MD_SOURCE_BYTES
    const found: Array<AgentsFile> = []
    const omitted: Array<string> = []
    const seen = new Set<string>()
    const take = (result: ReadResult): void => {
      if (result.tooLarge !== undefined) {
        omitted.push(result.tooLarge)
        return
      }
      const file = result.file
      if (file === undefined) return
      const digest = file.text.trim()
      if (seen.has(digest)) return
      seen.add(digest)
      found.push(file)
    }

    if (options.home !== undefined) {
      take(yield* readIfPresent(join(options.home, names[0] ?? AGENTS_FILE), cap))
    }
    const candidates = candidatesOf(options)
    for (const directory of chainFrom(
      yield* projectRootOf(cwd, options.rootMarker ?? PROJECT_ROOT_MARKER),
      cwd,
    )) {
      for (const name of candidates) take(yield* readIfPresent(join(directory, name), cap))
    }
    return { files: found, omitted }
  })
}

/**
 * The preamble that ranks the instruction files against each other and against the
 * prompt's own orders. It rides its own section so the byte budget of the files
 * below stays what it was.
 */
export const AGENTS_MD_PRECEDENCE = [
  'More specific instructions take precedence over broader ones.',
  'They do not override system, developer, or direct user instructions.',
].join('\n')

/** Section text of one instruction file. */
export const agentsMdSectionText = (file: AgentsFile): string =>
  'Instructions from ' + file.path + ':\n' + file.text.trimEnd()

const takeBytes = (text: string, maxBytes: number): { text: string; bytes: number } => {
  let bytes = 0
  let end = 0
  for (const point of text) {
    const size = byteLength(point)
    if (bytes + size > maxBytes) break
    bytes += size
    end += point.length
  }
  return { text: text.slice(0, end), bytes }
}

const budgetNotice = (
  maxBytes: number,
  omitted: ReadonlyArray<string>,
  truncated: ReadonlyArray<TruncatedAgentsFile>,
): string | undefined => {
  if (omitted.length === 0 && truncated.length === 0) return undefined
  const parts: Array<string> = []
  if (truncated.length > 0) {
    parts.push(
      'truncated ' +
        truncated
          .map((file) => `${file.path} from ${file.originalBytes} to ${file.includedBytes} bytes`)
          .join(', '),
    )
  }
  if (omitted.length > 0) parts.push('omitted ' + omitted.join(', '))
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

/**
 * Renders instruction files as sections, nearest last. Files are included whole
 * while the budget allows; the first one that does not fit is cut at a character
 * boundary, and everything after it is omitted. When anything was cut, a notice
 * section names it, so the model knows the instructions are incomplete.
 */
export function agentsMdSections(
  load: AgentsLoad,
  options: { readonly order?: number; readonly maxBytes?: number } = {},
): AgentsSections {
  const order = options.order ?? AGENTS_MD_ORDER
  const maxBytes = options.maxBytes ?? AGENTS_MD_BUDGET_BYTES
  const sections: Array<PromptSection> = []
  const omitted = [...load.omitted]
  const truncated: Array<TruncatedAgentsFile> = []
  let spent = 0
  let full = true

  if (load.files.length > 0) {
    sections.push({ name: 'agents-md:precedence', order, text: AGENTS_MD_PRECEDENCE })
  }

  load.files.forEach((file, index) => {
    const text = agentsMdSectionText(file)
    const size = byteLength(text)
    if (!full || spent + size > maxBytes) {
      if (!full) {
        omitted.push(file.path)
        return
      }
      const room = takeBytes(text, maxBytes - spent)
      if (room.bytes === 0) {
        omitted.push(file.path)
        return
      }
      spent += room.bytes
      truncated.push({ path: file.path, originalBytes: size, includedBytes: room.bytes })
      sections.push({ name: `agents-md:${index + 1}`, order: order + index + 1, text: room.text })
      full = false
      return
    }
    spent += size
    sections.push({ name: `agents-md:${index + 1}`, order: order + index + 1, text })
  })

  const notice = budgetNotice(maxBytes, omitted, truncated)
  return notice === undefined
    ? { sections }
    : {
        sections,
        notice: { name: 'agents-md:budget', order: order - 1, text: notice },
      }
}

/** Files discovery already put in the prompt, keyed by path with their trimmed text. */
export type LoadedAgents = ReadonlyMap<string, string>

export const loadedAgentsOf = (load: AgentsLoad): Map<string, string> =>
  new Map(load.files.map((file) => [file.path, file.text.trim()]))

export interface NestedAgentsRequest {
  /** The workspace root; nested instructions live below it. */
  readonly root: string
  /** The working directory in force; the search starts at the touched file. */
  readonly cwd: string
  /** The file a tool touched, absolute or relative to `cwd`. */
  readonly path: string
}

/**
 * The instruction files that begin to apply to a directory a tool just touched:
 * the directories between the workspace root and the file, outermost first,
 * skipping files already loaded and files whose text is already loaded.
 */
/** The directories between the root (exclusive) and the file's own, outermost first. */
const directoriesBelow = (root: string, target: string): ReadonlyArray<string> => {
  const directories: Array<string> = []
  let directory = dirname(target)
  while (inside(root, directory) && directory !== root) {
    directories.push(directory)
    directory = dirname(directory)
  }
  return directories.reverse()
}

export function nestedAgentsFiles(
  loaded: LoadedAgents,
  request: NestedAgentsRequest,
  options: AgentsMdOptions = {},
): Effect.Effect<ReadonlyArray<AgentsFile>> {
  return Effect.gen(function* () {
    const cap = options.maxSourceBytes ?? AGENTS_MD_SOURCE_BYTES
    const target = request.path.startsWith('/') ? request.path : join(request.cwd, request.path)
    const found: Array<AgentsFile> = []
    const seen = new Set(loaded.values())

    const read = (path: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (loaded.has(path)) return
        const result = yield* readIfPresent(path, cap)
        const file = result.file
        if (file === undefined) return
        const digest = file.text.trim()
        if (seen.has(digest)) return
        seen.add(digest)
        found.push(file)
      })

    const candidates = candidatesOf(options)
    for (const directory of directoriesBelow(request.root, target)) {
      for (const name of candidates) yield* read(join(directory, name))
    }
    return found
  })
}

/**
 * The message the model reads when instructions first apply to a directory. The
 * path is absolute; `scope` is the directory relative to the workspace root.
 */
export const additionalInstructionsText = (file: AgentsFile, scope: string): string =>
  [
    `Additional instructions from: ${file.path}`,
    '',
    scope === '.'
      ? 'These instructions apply to work in the workspace root.'
      : `These instructions apply to work under \`${scope}\`.`,
    'Use them as guidance when relevant; more specific instructions take precedence.',
    'They do not override system, developer, or direct user instructions.',
    '',
    file.text.trimEnd(),
  ].join('\n')

/**
 * Reads and registers the instructions that apply before the first turn. The
 * returned load carries the files, so the caller can look for nested ones later.
 */
export function registerAgentsMd(
  prompt: SystemPromptShape,
  cwd: string,
  options: AgentsMdOptions = {},
): Effect.Effect<AgentsLoad, PromptError, Scope.Scope> {
  return Effect.gen(function* () {
    const load = yield* loadAgentsFiles(cwd, options)
    const rendered = agentsMdSections(load, options)
    if (rendered.notice !== undefined) yield* prompt.section(rendered.notice)
    for (const section of rendered.sections) yield* prompt.section(section)
    return load
  })
}
