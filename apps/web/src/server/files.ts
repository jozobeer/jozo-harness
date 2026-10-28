import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Dirent } from 'node:fs'
import { Effect } from 'effect'
import {
  IGNORED_DIRECTORIES,
  type IgnoredPaths,
  comparePaths,
  makeIgnoredPaths,
  readIgnoreRules,
  walkFiles,
} from '@jozo-harness/tools-tier0'
import { realOf, within } from './inside.ts'

/** The most paths one reference query answers with. */
export const FILE_MATCHES = 50

/** Where the walk stops: one broad listing per keystroke still has to end. */
const WALK_LIMIT = 20_000

/** The most entries one folder hands the tree; a page draws a list, not a dump. */
const TREE_ENTRIES = 1_000

/** One entry the tree shows: a folder it may open, or a file it may hand on. */
export interface WorkspaceEntry {
  readonly name: string
  readonly kind: 'directory' | 'file'
}

/**
 * One folder of the workspace tree. `path` is relative to the workspace root
 * and '' names the root itself, so the page can keep what it opened by the name
 * it asked for.
 */
export interface WorkspaceDirectory {
  readonly path: string
  /** Folders first, then files, each by name. */
  readonly entries: ReadonlyArray<WorkspaceEntry>
  /** True when the folder holds more than one listing carries. */
  readonly truncated: boolean
}

/** A path is named either by a segment that starts with the word, or only by holding it. */
const rankOf = (path: string, word: string): number =>
  path
    .toLowerCase()
    .split('/')
    .some((segment) => segment.startsWith(word))
    ? 0
    : 1

/**
 * The workspace paths one reference word names, best first. The walk is the
 * one every search uses, so .gitignore holds and dot-entries stay visible; the
 * page never reads the tree itself. An empty word names nothing.
 */
export const searchWorkspaceFiles = (
  cwd: string,
  query: string,
  limit: number = FILE_MATCHES,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const word = query.trim().toLowerCase()
    if (word === '') return []
    const walked = yield* walkFiles({ cwd, limit: WALK_LIMIT })
    return walked
      .filter((path) => path.toLowerCase().includes(word))
      .map((path) => ({ path, rank: rankOf(path, word) }))
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          left.path.length - right.path.length ||
          comparePaths(left.path, right.path),
      )
      .slice(0, limit)
      .map((one) => one.path)
  })

/** What stat says about an existing path, or undefined when it went away. */
const statOf = (path: string): Effect.Effect<Awaited<ReturnType<typeof stat>> | undefined> =>
  Effect.tryPromise({
    try: () => stat(path),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

/**
 * The real path of one folder the workspace may read. Both the typed name and
 * the link's target must land in the tree: a link is a way out whatever the
 * word looks like, so the check reads the real path.
 */
const folderInside = (root: string, path: string): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const target = resolve(root, path)
    if (!within(root, target))
      return yield* Effect.fail(new Error('the folder is outside the workspace'))
    const real = yield* realOf(target)
    if (real === undefined) return yield* Effect.fail(new Error('no such folder'))
    if (!within(root, real))
      return yield* Effect.fail(new Error('the folder is outside the workspace'))
    const info = yield* statOf(real)
    if (info === undefined) return yield* Effect.fail(new Error('no such folder'))
    if (!info.isDirectory()) return yield* Effect.fail(new Error('the path is not a folder'))
    return real
  })

/** Only a folder or a file is shown; a socket, a pipe, or a device is not a thing to open. */
const kindOfInfo = (
  info: Pick<Dirent, 'isDirectory' | 'isFile'>,
): WorkspaceEntry['kind'] | undefined => {
  if (info.isDirectory()) return 'directory'
  if (info.isFile()) return 'file'
  return undefined
}

/**
 * What one name under a folder is, or undefined when the tree may not show it.
 * A link is followed and judged by where it lands, so a link out of the tree and
 * a link whose target is gone both stay out of the listing.
 */
const kindOf = (
  root: string,
  folder: string,
  entry: Dirent,
): Effect.Effect<WorkspaceEntry['kind'] | undefined> =>
  Effect.gen(function* () {
    if (!entry.isSymbolicLink()) return kindOfInfo(entry)
    const real = yield* realOf(join(folder, entry.name))
    if (real === undefined || !within(root, real)) return undefined
    const info = yield* statOf(real)
    return info === undefined ? undefined : kindOfInfo(info)
  })

/** The name one folder is known by: the typed name without a trailing slash; '' is the root. */
const nameOf = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, '')
  return trimmed === '.' ? '' : trimmed
}

/** The name the tree says one entry by: the workspace root is the empty prefix. */
const relativeOf = (path: string, name: string): string => (path === '' ? name : path + '/' + name)

/**
 * One dirent as the listing shows it, or undefined when it stays out. The rules
 * are the search's: node_modules and .git never appear, and the workspace's
 * ignore files hold for the name the tree would show.
 */
const entryOf = (
  root: string,
  folder: string,
  relativePath: string,
  entry: Dirent,
  ignored: IgnoredPaths,
): Effect.Effect<WorkspaceEntry | undefined> =>
  Effect.gen(function* () {
    const kind = yield* kindOf(root, folder, entry)
    if (kind === undefined) return undefined
    if (kind === 'directory' && IGNORED_DIRECTORIES.has(entry.name)) return undefined
    if (ignored.ignores(relativePath, kind === 'directory')) return undefined
    return { name: entry.name, kind }
  })

/** Folders before files, each by name, so the tree reads the same twice. */
const orderOf = (left: WorkspaceEntry, right: WorkspaceEntry): number =>
  (left.kind === right.kind ? 0 : left.kind === 'directory' ? -1 : 1) ||
  comparePaths(left.name, right.name)

/**
 * One folder of the workspace tree, read only when the tree opens it. The
 * listing keeps the search's rules: node_modules and .git stay out, .gitignore
 * holds, and dot-entries stay visible. A folder that is not in the workspace, or
 * that a link points at from outside it, is refused rather than listed.
 */
export const listWorkspaceDirectory = (
  cwd: string,
  typed: string,
): Effect.Effect<WorkspaceDirectory, Error> =>
  Effect.gen(function* () {
    const root = (yield* realOf(cwd)) ?? resolve(cwd)
    // A name written with a trailing slash is the same folder, and the children
    // are named from the folder without it, so the page keeps one key per folder.
    const path = nameOf(typed)
    const folder = yield* folderInside(root, path)
    const dirents = yield* Effect.tryPromise({
      try: () => readdir(folder, { withFileTypes: true }),
      catch: () => new Error('cannot read this folder'),
    })
    const ignored = makeIgnoredPaths(yield* readIgnoreRules(root))
    const found = yield* Effect.forEach(
      dirents,
      (dirent) => entryOf(root, folder, relativeOf(path, dirent.name), dirent, ignored),
      { concurrency: 1 },
    )
    const entries = found.filter((one): one is WorkspaceEntry => one !== undefined).sort(orderOf)
    return {
      path,
      entries: entries.slice(0, TREE_ENTRIES),
      truncated: entries.length > TREE_ENTRIES,
    }
  })
