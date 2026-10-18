import { spawnSync } from 'node:child_process'
import { wrapForProvider, type SandboxShape } from './sandbox.ts'
import type { SandboxMode } from './policy.ts'

export interface BwrapOptions {
  /** The mode commands run under unless one call asks for another. */
  readonly mode: SandboxMode
  /** Directories the sandboxed process may write, on top of its own cwd and the temp dir. */
  readonly writableRoots: ReadonlyArray<string>
}

/** How a probe answers whether a command can run; tests replace it with a stub. */
export type CommandProbe = (argv: ReadonlyArray<string>) => boolean

/**
 * The bwrap flags that give a command the same boundary seatbelt does: the host
 * root mounted read-only, a fresh /dev so /dev/null still works, and a private
 * PID namespace whose /proc holds only this command's descendants.
 */
export function bwrapArgs(writableRoots: ReadonlyArray<string>): ReadonlyArray<string> {
  const roots = [...new Set(writableRoots)]
  return [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--die-with-parent',
    ...roots.flatMap((root) => ['--bind-try', root, root]),
    '--',
  ]
}

/**
 * What the kernel prints when bwrap refuses a write: the host root is a read-only
 * bind, so a write outside the bound roots fails with EROFS. It is distinctive
 * enough that a command failing for another reason is not read as a denial.
 */
const DENIAL_SIGNATURES: ReadonlyArray<string> = ['read-only file system']

/** The probe a real process uses: run the command and read its exit status. */
export const commandRuns: CommandProbe = (argv) => {
  const [file, ...args] = argv
  if (file === undefined) return false
  const result = spawnSync(file, args, { stdio: 'ignore' })
  return result.status === 0
}

/**
 * bwrap can be installed but still unable to create the namespaces it needs (for
 * example when a distribution's AppArmor profile forbids unprivileged user
 * namespaces). The version probe alone would then pass while every command fails,
 * so the probe also runs one minimal command.
 */
export function probeBwrap(run: CommandProbe = commandRuns): boolean {
  if (!run(['bwrap', '--version'])) return false
  return run(['bwrap', ...bwrapArgs([]), 'true'])
}

/** Why Linux has no usable bwrap, and what the caller can do about it. */
export const bwrapUnavailableMessage = (platform: string): string =>
  'no usable bwrap sandbox on ' +
  platform +
  ': bwrap is not installed, or it cannot create the user namespace it needs. ' +
  'Install bubblewrap (bwrap) or pass sandbox: none to run commands without one. ' +
  'The landlock fallback is not implemented yet.'

/**
 * Wraps commands with bwrap on Linux. The mode decides what the command may
 * write, the same way seatbelt does: workspace-write adds the directory it runs
 * in and the temp dir, read-only adds neither, and danger-full-access leaves the
 * command as it is.
 */
export function bwrapSandbox(options: BwrapOptions): SandboxShape {
  return {
    name: 'bwrap',
    confines: true,
    enforcement: 'full',
    mode: options.mode,
    wrap: (command) =>
      wrapForProvider(
        command,
        options.mode,
        options.writableRoots,
        DENIAL_SIGNATURES,
        (_mode, writableRoots) => ['bwrap', ...bwrapArgs(writableRoots), ...command.argv],
      ),
  }
}
