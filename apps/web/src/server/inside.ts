import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { Effect } from 'effect'

/**
 * True when `path` is `root` or sits under it. Every read the page asks for
 * passes this, so a name that climbed out with `..` or an absolute word stops
 * before anything touches the disk.
 */
export const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The real path of something that must exist, or undefined when it does not.
 * A symlink is a way out whatever its name looks like, so a caller checks the
 * answer against the root rather than the name it was given.
 */
export const realOf = (path: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))
