import { execFile } from 'node:child_process'
import { Effect } from 'effect'

/** How long one git lookup may take before the strip gives up on a branch. */
const GIT_TIMEOUT_MS = 2_000

/**
 * The branch a workspace stands on, resolved by git itself: a worktree and a
 * submodule answer as their plain clone does, and no `.git` layout is read
 * here. null when the directory is not a git workspace, HEAD is detached, or
 * git cannot answer at all, so the status strip keeps the path alone.
 */
export const branchOf = (cwd: string): Effect.Effect<string | null> =>
  Effect.callback<string>((resume) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        resume(Effect.succeed(error === null ? stdout.trim() : ''))
      },
    )
  }).pipe(Effect.map((name) => (name === '' || name === 'HEAD' ? null : name)))
