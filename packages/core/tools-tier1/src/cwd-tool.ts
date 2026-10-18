import { isAbsolute, relative, resolve, sep } from 'node:path'
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

/** Moves the working directory, as long as it stays inside the workspace. */
export const makeWorkingDirectoryTool = (
  host: WorkingDirectoryHost,
): ToolDefinition<WorkingDirectoryArgs, WorkingDirectoryValue> => ({
  name: 'working_directory',
  description:
    'Moves the working directory inside the workspace for the tools that follow. Use it instead of chaining cd into every bash command.',
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
      yield* host.change(target)
      return { cwd: target }
    }),
})
