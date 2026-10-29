import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Effect } from 'effect'
import type { FileSystemShape } from '@jozo-harness/filesystem'
import type { SandboxMode } from '@jozo-harness/safety'
import { ToolError } from '@jozo-harness/tools'

/**
 * The one synchronous question a confinement asks: is this component a link?
 * It is passed in rather than read from the file seam, because a path is confined
 * before any file is opened and some confined tools never touch that seam.
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
  const linked = linkIn(links, root, inside)
  if (linked !== undefined) {
    return Effect.fail(
      new ToolError({
        code: 'denied',
        message: path + ' goes through a link: ' + linked + '; write the path it points to instead',
      }),
    )
  }
  return Effect.succeed(target)
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
const linkIn = (links: LinkLookup, root: string, inside: string): string | undefined => {
  let walk = root
  for (const part of inside.split(sep)) {
    walk = join(walk, part)
    const info = links.lstat(walk)
    if (info === undefined) return undefined
    if (info.isSymbolicLink) return walk
  }
  return undefined
}
