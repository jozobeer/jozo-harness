import { readFile, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, matchesGlob } from 'node:path'
import { Effect } from 'effect'

/** Path order, the tie-break of every ordering. */
export const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/** Directories that hold other people's code; a search never walks into them. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules'])
/** How much of a file is sniffed for a NUL byte when deciding whether it is binary. */
export const BINARY_SNIFF_BYTES = 8192

/** One rule of a gitignore-like file. */
export interface IgnoreRule {
  readonly negated: boolean
  /** The rule speaks only for directories. */
  readonly directoryOnly: boolean
  /** The rule is relative to the workspace root rather than matching at any depth. */
  readonly anchored: boolean
  readonly pattern: string
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g

/** The regular expression one rule uses, in the gitignore subset this walker honours. */
const ruleExpression = (rule: IgnoreRule): RegExp => {
  const body = rule.pattern
    .replace(REGEX_SPECIALS, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  const anywhere = rule.anchored ? '' : '(?:^|.*/)'
  return new RegExp(anywhere + body + '(?:/.*)?$')
}

const parseRule = (line: string): IgnoreRule | undefined => {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return undefined
  const negated = trimmed.startsWith('!')
  const marked = negated ? trimmed.slice(1) : trimmed
  const directoryOnly = marked.endsWith('/')
  const raw = directoryOnly ? marked.slice(0, -1) : marked
  const anywhere = raw.startsWith('**/')
  const pattern = anywhere ? raw.slice(3) : raw
  const anchored = !anywhere && (raw.startsWith('/') || pattern.includes('/'))
  return { negated, directoryOnly, anchored, pattern }
}

/** The ignore files one workspace may carry, read in the order they win. */
const IGNORE_FILES = ['.gitignore', '.ignore'] as const

const textIfPresent = (path: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(() =>
    readFile(path, 'utf8')
      .then((text) => text.split('\n'))
      .catch(() => []),
  )

/** The rules the workspace root states; nested ignore files are not read. */
export const readIgnoreRules = (cwd: string): Effect.Effect<ReadonlyArray<IgnoreRule>> =>
  Effect.gen(function* () {
    const rules: Array<IgnoreRule> = []
    for (const name of IGNORE_FILES) {
      for (const line of yield* textIfPresent(join(cwd, name))) {
        const rule = parseRule(line)
        if (rule !== undefined) rules.push(rule)
      }
    }
    return rules
  })

export interface IgnoredPaths {
  /** Whether the workspace-relative path is excluded; the last matching rule wins. */
  ignores(relativePath: string, isDirectory: boolean): boolean
}

/** Prepares the rules for many lookups. */
export const makeIgnoredPaths = (rules: ReadonlyArray<IgnoreRule>): IgnoredPaths => {
  const compiled = rules.map((rule) => ({ rule, expression: ruleExpression(rule) }))
  return {
    ignores: (relativePath, isDirectory) => {
      let ignored = false
      for (const { rule, expression } of compiled) {
        if (rule.directoryOnly && !isDirectory) continue
        if (expression.test(relativePath)) ignored = !rule.negated
      }
      return ignored
    },
  }
}

/** Whether a file's head looks like binary data rather than text. */
export const isBinary = (bytes: Uint8Array): boolean =>
  bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)

/** How the collected paths are ordered. */
export type WalkOrder = 'path' | 'modified'

export interface WalkRequest {
  readonly cwd: string
  /** The most paths to collect; the walk stops there. */
  readonly limit: number
  /** When given, only files whose workspace-relative path matches are collected. */
  readonly pattern?: string
  /**
   * The workspace-relative directory to start at; the collected paths stay
   * workspace-relative. Omitted, the walk starts at the workspace root.
   */
  readonly start?: string
  /** `path` (default) sorts by name; `modified` sorts by modification time, oldest first. */
  readonly order?: WalkOrder
}

interface Walk {
  readonly limit: number
  readonly pattern: string | undefined
  readonly ignored: IgnoredPaths
  readonly found: Array<string>
}

const readEntries = (directory: string) =>
  Effect.promise(() =>
    readdir(directory, { withFileTypes: true }).then(
      (entries) => entries,
      () => [],
    ),
  )

const skipDirectory = (walk: Walk, name: string, relative: string): boolean =>
  IGNORED_DIRECTORIES.has(name) || walk.ignored.ignores(relative, true)

const acceptsFile = (walk: Walk, relative: string): boolean =>
  !walk.ignored.ignores(relative, false) &&
  (walk.pattern === undefined || matchesGlob(relative, walk.pattern))

const relativeOf = (prefix: string, name: string): string =>
  prefix === '' ? name : prefix + '/' + name

/** Descends into one entry, or collects it when it is a file the rules let through. */
const takeEntry = (
  walk: Walk,
  directory: string,
  prefix: string,
  entry: Dirent,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const relative = relativeOf(prefix, entry.name)
    if (entry.isDirectory()) {
      if (!skipDirectory(walk, entry.name, relative)) {
        yield* collectFrom(walk, join(directory, entry.name), relative)
      }
      return
    }
    if (entry.isFile() && acceptsFile(walk, relative)) walk.found.push(relative)
  })

/**
 * Every entry is considered, dot-entries included: a search that silently hides
 * `.github` or `.agents` makes the model conclude a file does not exist. Only
 * the directories in IGNORED_DIRECTORIES stay out.
 */
const collectFrom = (walk: Walk, directory: string, prefix: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const entry of yield* readEntries(directory)) {
      if (walk.found.length >= walk.limit) return
      yield* takeEntry(walk, directory, prefix, entry)
    }
  })

/** Each collected path with the modification time the order needs; a file that vanished reads as 0. */
const withTimes = (
  cwd: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<{ readonly path: string; readonly mtimeMs: number }>> =>
  Effect.promise(() =>
    Promise.all(
      paths.map(async (path) => {
        const info = await stat(join(cwd, path)).catch(() => undefined)
        return { path, mtimeMs: info?.mtimeMs ?? 0 }
      }),
    ),
  )

/** The collected paths in the requested order, with the path breaking every tie. */
export const orderPaths = (
  cwd: string,
  paths: ReadonlyArray<string>,
  order: WalkOrder,
): Effect.Effect<ReadonlyArray<string>> =>
  order === 'path'
    ? Effect.succeed([...paths].sort(comparePaths))
    : Effect.map(withTimes(cwd, paths), (timed) =>
        [...timed]
          .sort(
            (left, right) => left.mtimeMs - right.mtimeMs || comparePaths(left.path, right.path),
          )
          .map((entry) => entry.path),
      )

/**
 * Every file under `cwd` (or under `start` when given) that survives the
 * ignore files, in the requested order. A path that is a directory the rules
 * exclude is never walked, so its contents cost nothing; dot-entries other than
 * the ignored directories are walked; the walk stops at `limit`.
 */
export const walkFiles = (request: WalkRequest): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const walk: Walk = {
      limit: request.limit,
      pattern: request.pattern,
      ignored: makeIgnoredPaths(yield* readIgnoreRules(request.cwd)),
      found: [],
    }
    const start = request.start ?? ''
    yield* collectFrom(walk, start === '' ? request.cwd : join(request.cwd, start), start)
    return yield* orderPaths(request.cwd, walk.found, request.order ?? 'path')
  })
