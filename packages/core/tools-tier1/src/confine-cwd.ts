import { isAbsolute, resolve } from 'node:path'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'
import type { SandboxShape } from '@jozo-harness/safety'
import { ToolError } from '@jozo-harness/tools'
import { resolveInside } from '@jozo-harness/tools-tier0'
import { Effect } from 'effect'

/**
 * The directory a child agent or a delegated command may start in.
 *
 * That directory becomes the root of `write` / `edit` and a writable root of
 * the sandbox, so a path outside the workspace would drop the parent's
 * boundary. Full access already has no boundary. The workspace root itself is
 * a valid directory; `resolveInside` refuses it because it is the boundary
 * rather than a path under it. Read-only still uses the workspace-write path
 * rule, as bash does: choosing the directory is not a write, and the mode
 * still refuses writes after the child starts.
 */
export const confineCwd = (
  root: string,
  cwd: string | undefined,
  sandbox?: SandboxShape,
): Effect.Effect<string, ToolError> => {
  if (cwd === undefined) return Effect.succeed(root)
  if (sandbox?.mode === 'danger-full-access') {
    return resolveInside(nodeFileSystem, root, cwd, 'danger-full-access')
  }
  const target = isAbsolute(cwd) ? resolve(cwd) : resolve(root, cwd)
  if (target === resolve(root)) return Effect.succeed(target)
  return resolveInside(nodeFileSystem, root, cwd)
}
