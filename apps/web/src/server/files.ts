import { Effect } from 'effect'
import { walkFiles } from '@jozo-harness/tools-tier0'

/** The most paths one reference query answers with. */
export const FILE_MATCHES = 50

/** Where the walk stops: one broad listing per keystroke still has to end. */
const WALK_LIMIT = 20_000

/** A path is named either by a segment that starts with the word, or only by holding it. */
const rankOf = (path: string, word: string): number =>
  path
    .toLowerCase()
    .split('/')
    .some((segment) => segment.startsWith(word))
    ? 0
    : 1

/** Path order, the tie-break a page needs so the same query answers the same way. */
const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

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
