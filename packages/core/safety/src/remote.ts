import { Effect } from 'effect'
import type { SandboxMode } from './policy.ts'
import type { SandboxCommand, SandboxShape } from './sandbox.ts'

/**
 * The sandbox a command runs under on a remote POSIX host: the argv the caller
 * hands back is the ssh invocation itself, and the boundary is the host's own
 * bwrap. A write outside the workspace is then refused by the remote kernel, so
 * the command is as confined there as it would be here.
 */

/** A value as one shell word with nothing special left in it. */
const quote = (value: string): string => "'" + value.split("'").join("'\\''") + "'"

/** What a remote bwrap refuses with: the host root is a read-only bind, so a write fails with EROFS. */
const DENIAL_SIGNATURES: ReadonlyArray<string> = ['read-only file system']

/** The flags the host's bwrap gets; the same boundary the local Linux sandbox applies. */
export const remoteBwrapArgs = (writableRoots: ReadonlyArray<string>): ReadonlyArray<string> => {
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

/** The roots a mode lets a remote command write: the workspace and the host's temp dir. */
export const remoteWritableRoots = (
  mode: SandboxMode,
  cwd: string,
  standingRoots: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...new Set([...standingRoots, ...(mode === 'workspace-write' ? [cwd, '/tmp'] : [])]),
]

/**
 * The shell program one call runs on the host: change to the directory the call
 * named, then start the command, wrapped by bwrap when the mode confines. The
 * command reaches `sh -c` as one quoted word, so its own quoting survives.
 */
export const remoteProgram = (
  command: SandboxCommand,
  root: string,
  mode: SandboxMode,
  standingRoots: ReadonlyArray<string>,
  confines: boolean,
): string => {
  const run = command.argv.map((word) => quote(word)).join(' ')
  const body =
    confines && mode !== 'danger-full-access'
      ? [
          'bwrap',
          ...remoteBwrapArgs(remoteWritableRoots(mode, root, standingRoots)),
          'sh',
          '-c',
          run,
        ]
          .map((word) => quote(word))
          .join(' ')
      : run
  return 'cd ' + quote(command.cwd) + ' && exec ' + body
}

export interface RemoteSandboxOptions {
  /**
   * The argv that starts a shell on the host, given the program to run:
   * `ssh` and its flags before `sh -c <program>`.
   */
  readonly reach: (program: string) => ReadonlyArray<string>
  /** The workspace on the remote host: the directory a command runs in. */
  readonly cwd: string
  /** The mode commands run under unless one call asks for another. */
  readonly mode: SandboxMode
  /**
   * True when the host has a usable bwrap. The caller probes it once for this
   * host; a host without one is reported by `probeRemoteBwrap` instead of
   * running commands unconfined.
   */
  readonly confines: boolean
  /** Directories the remote sandbox may write, on top of the command's cwd and /tmp. */
  readonly writableRoots?: ReadonlyArray<string>
  /**
   * The directory the local ssh process starts in. A remote path is not a
   * directory on this machine, so the local side gets one that exists.
   */
  readonly localCwd?: string
}

/**
 * The sandbox for one remote host. `danger-full-access` leaves the command as it
 * is; every other mode wraps it in the host's bwrap. A host with no bwrap keeps
 * `confines: false`, so nothing above reads a refusal it cannot get.
 */
export const remoteSandbox = (options: RemoteSandboxOptions): SandboxShape => ({
  name: options.confines ? 'bwrap (remote)' : 'none (remote)',
  confines: options.confines,
  ...(options.confines ? { enforcement: 'full' as const } : {}),
  mode: options.confines ? options.mode : 'danger-full-access',
  wrap: (command: SandboxCommand) => {
    const mode = options.confines ? (command.mode ?? options.mode) : 'danger-full-access'
    const program = remoteProgram(
      command,
      options.cwd,
      mode,
      options.writableRoots ?? [],
      options.confines,
    )
    return Effect.succeed({
      // ssh joins its arguments with spaces and the host's shell parses the
      // result, so the program reaches it as one quoted word.
      argv: options.reach(quote(program)),
      cwd: options.localCwd ?? process.cwd(),
      mode,
      denialSignatures: options.confines && mode !== 'danger-full-access' ? DENIAL_SIGNATURES : [],
    })
  },
})

/** One host a session may work on instead of this machine, as the sandbox reads it. */
export interface SshSandboxOptions {
  /** The argv before `sh -c <program>`: `ssh` and the flags that pick the host. */
  readonly reach: ReadonlyArray<string>
  /** The workspace on the remote host; a command runs in it. */
  readonly root: string
  /** The mode commands run under. Defaults to workspace-write. */
  readonly mode?: SandboxMode
  /** Whether the host can run bwrap; the caller probes it once. */
  readonly confines: boolean
}

/** The sandbox over one ssh host: every wrapped command is the ssh invocation itself. */
export const sshSandbox = (options: SshSandboxOptions): SandboxShape =>
  remoteSandbox({
    reach: (program) => [...options.reach, 'sh', '-c', program],
    cwd: options.root,
    mode: options.mode ?? 'workspace-write',
    confines: options.confines,
  })
