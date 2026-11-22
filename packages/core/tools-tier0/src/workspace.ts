import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Effect } from 'effect'
import type { FileSystemShape } from '@jozo-harness/filesystem'
import type { SandboxMode } from '@jozo-harness/safety'
import { ToolError } from '@jozo-harness/tools'

/**
 * The one question a confinement asks about a path's parts: is this component a
 * link? It is passed in rather than read from the file seam, because some
 * confined tools never touch that seam, and it is asynchronous because a seam
 * over a network answers it in a round trip.
 */
export type LinkLookup = Pick<FileSystemShape, 'lstat'>

/**
 * The one place a path becomes a path a tool may use. Everything that writes, or
 * runs somewhere, goes through here. The mode draws the boundary: full access
 * takes any path, workspace-write takes only paths under the workspace that go
 * through no link — a link would let the work out while the path still reads as
 * if it stayed inside — and read-only takes none of them.
 *
 * @param links - how to ask whether a component is a link.
 * @param root - the workspace the call runs in.
 * @param path - the path the caller named, absolute or relative.
 * @param mode - the sandbox mode the call runs under.
 * @returns the path to use, or why this mode refuses it.
 */
export const resolveInside = (
  links: LinkLookup,
  root: string,
  path: string,
  mode: SandboxMode = 'workspace-write',
): Effect.Effect<string, ToolError> => {
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  if (mode === 'danger-full-access') return Effect.succeed(target)
  if (mode === 'read-only') {
    return Effect.fail(
      new ToolError({ code: 'denied', message: 'read-only mode writes nothing: ' + path }),
    )
  }
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return Effect.fail(
      new ToolError({ code: 'denied', message: 'path escapes the workspace: ' + path }),
    )
  }
  return Effect.flatMap(linkIn(links, root, inside), (linked) =>
    linked === undefined
      ? Effect.succeed(target)
      : Effect.fail(
          new ToolError({
            code: 'denied',
            message:
              path + ' goes through a link: ' + linked + '; write the path it points to instead',
          }),
        ),
  )
}

/**
 * The workspace-relative directory a search starts at, or the root itself when
 * the caller names none. The same boundary as every other path applies, so a
 * search cannot be pointed outside the workspace or through a link.
 *
 * @param links - how to ask whether a component is a link.
 * @param root - the workspace the call runs in.
 * @param path - the directory the caller named, absolute or relative.
 * @returns the workspace-relative start, empty for the workspace root.
 */
export const resolveSearchStart = (
  links: LinkLookup,
  root: string,
  path: string | undefined,
): Effect.Effect<string, ToolError> => {
  if (path === undefined) return Effect.succeed('')
  const named = isAbsolute(path) ? resolve(path) : resolve(root, path)
  if (named === resolve(root)) return Effect.succeed('')
  return Effect.map(resolveInside(links, root, path, 'workspace-write'), (inside) =>
    relative(root, inside).split(sep).join('/'),
  )
}

/** The first component below the root that is a link, if any. Parts that are not there yet are new work. */
const linkIn = (
  links: LinkLookup,
  root: string,
  inside: string,
): Effect.Effect<string | undefined> => {
  const parts = inside.split(sep)
  // One component per round trip: a seam over a network must not walk the whole
  // path when the first component already answers.
  const walk = (index: number, path: string): Effect.Effect<string | undefined> => {
    const part = parts[index]
    if (part === undefined) return Effect.succeed(undefined)
    const next = join(path, part)
    return Effect.flatMap(links.lstat(next), (info) => {
      if (info === undefined) return Effect.succeed(undefined)
      return info.isSymbolicLink ? Effect.succeed(next) : walk(index + 1, next)
    })
  }
  return walk(0, root)
}
