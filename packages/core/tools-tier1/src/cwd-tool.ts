import { lstatSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Schema, Effect } from 'effect'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description: 'The directory to move to, inside the workspace.',
  }),
})

export type WorkingDirectoryArgs = Schema.Schema.Type<typeof Parameters>

export interface WorkingDirectoryValue {
  readonly cwd: string
}

export interface WorkingDirectoryHost {
  /** The workspace root in force; a worktree moves it, so it is read per call. */
  readonly root: () => string
  /** Records the change; the agent loop then uses the newest one. */
  readonly change: (cwd: string) => Effect.Effect<void, ToolError>
}

/**
 * The first component below the root that is a link, if any. A missing component
 * is new work, not a link. Later tools treat the path this call records as their
 * workspace root and do not inspect that root, so a link here would be followed
 * out of the workspace by write, edit, and the sandbox's writable directory.
 */
const linkBelow = (root: string, inside: string): string | undefined => {
  // The root itself is the workspace, so only components below it can be a link.
  if (inside === '') return undefined
  let walk = root
  for (const part of inside.split(sep)) {
    walk = join(walk, part)
    const info = lstatSync(walk, { throwIfNoEntry: false })
    if (info === undefined) return undefined
    if (info.isSymbolicLink()) return walk
  }
  return undefined
}

/** Moves the working directory, as long as it stays inside the workspace. */
export const makeWorkingDirectoryTool = (
  host: WorkingDirectoryHost,
): ToolDefinition<WorkingDirectoryArgs, WorkingDirectoryValue> => ({
  name: 'working_directory',
  description:
    'Moves the working directory inside the workspace for the tools that follow. Use it instead of chaining cd into every bash command. A path that goes through a symbolic link is refused; name the directory the link points to.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({ cwd: Schema.String }),
    render: (_args, value) => [{ type: 'text', text: 'working directory is now ' + value.cwd }],
  },
  execute: (args) =>
    Effect.gen(function* () {
      const root = host.root()
      const target = isAbsolute(args.path) ? resolve(args.path) : resolve(root, args.path)
      // relative() returns '' when target is the root itself, which is inside the workspace.
      const inside = relative(resolve(root), target)
      const escapes = isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)
      if (escapes) {
        return yield* Effect.fail(
          new ToolError({ code: 'denied', message: 'path escapes the workspace: ' + args.path }),
        )
      }
      // The same rule as every other write path: a link is not inside just because
      // its spelling is. Name the directory it points to, which is checked again.
      const linked = linkBelow(resolve(root), inside)
      if (linked !== undefined) {
        return yield* Effect.fail(
          new ToolError({
            code: 'denied',
            message:
              args.path +
              ' goes through a link: ' +
              linked +
              '; name the directory it points to instead',
          }),
        )
      }
      yield* host.change(target)
      return { cwd: target }
    }),
})
