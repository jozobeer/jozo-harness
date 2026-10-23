import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { wrapForProvider, type SandboxShape } from './sandbox.ts'
import type { SandboxMode } from './policy.ts'

/** One SBPL profile's roots, without the mode that decides them. */
export interface SeatbeltProfileOptions {
  /** Directories the sandboxed process may write, on top of its own cwd and the temp dir. */
  readonly writableRoots: ReadonlyArray<string>
}

export interface SeatbeltOptions extends SeatbeltProfileOptions {
  /** The mode commands run under unless one call asks for another. */
  readonly mode: SandboxMode
}

const quote = (value: string): string =>
  '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

const subpaths = (roots: ReadonlyArray<string>): string =>
  roots.map((root) => '  (subpath ' + quote(root) + ')').join('\n')

/** The path a sandbox sees: on macOS the temp dir is reached through /private. */
const realpathOf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * A root reached through a symlink matches only where it really is, so a rule has to
 * name both: the temp dir is written to as `/var/...` and resolved as `/private/var/...`.
 */
const asRoots = (roots: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set([...roots, ...roots.map(realpathOf)]),
]

/**
 * Builds the SBPL profile macOS sandbox-exec reads. Reads are open, like the shell
 * the tools replace: denying them made every login shell fail on `~/.profile` and
 * git fail on `/dev/null`. Writes are closed to the roots the mode names.
 */
export function seatbeltProfile(options: SeatbeltProfileOptions): string {
  const writable = asRoots(options.writableRoots)
  const lines = [
    '(version 1)',
    '(allow default)',
    // The one write outside the roots that ordinary commands need: git opens it,
    // and a denied command exits with "could not open '/dev/null'".
    '(deny file-write*)',
    '(allow file-write*',
    '  (literal "/dev/null")',
    ...(writable.length > 0 ? [subpaths(writable)] : []),
    ')',
  ]
  return lines.join('\n') + '\n'
}

/**
 * What the kernel prints when seatbelt refuses a file effect. Matched against
 * stderr case-insensitively, so only a denial is read as one.
 */
const DENIAL_SIGNATURES: ReadonlyArray<string> = ['operation not permitted']

/** What the one startup probe found: the profile applied, was refused, or never ran. */
export type SeatbeltProbeResult = 'applies' | 'refused' | 'missing'

/** How the probe learns the outcome; tests replace the real spawn. */
export type SeatbeltProbe = (argv: ReadonlyArray<string>) => SeatbeltProbeResult

/** The smallest profile: enough to ask whether a nested sandbox can apply another. */
const PROBE_ARGV: ReadonlyArray<string> = [
  'sandbox-exec',
  '-p',
  '(version 1)(allow default)',
  '--',
  'true',
]

const runSeatbeltProbe: SeatbeltProbe = (argv) => {
  const [file, ...args] = argv
  if (file === undefined) return 'missing'
  const result = spawnSync(file, args, { stdio: 'ignore' })
  if (result.error !== undefined) return 'missing'
  return result.status === 0 ? 'applies' : 'refused'
}

/**
 * Asks once, at startup, whether this process can apply a seatbelt profile. A
 * seatbelt the host already applied refuses the nested one with exit 71, which no
 * command can survive, so every call would fail for a reason no mode can widen.
 */
export function probeSeatbelt(run: SeatbeltProbe = runSeatbeltProbe): SeatbeltProbeResult {
  return run(PROBE_ARGV)
}

/**
 * The one line startup says. A refused profile is named because no command escapes
 * it; a missing binary and an applied profile say nothing, and the run keeps the
 * behavior it had either way.
 */
export const seatbeltWarning = (result: SeatbeltProbeResult): string | undefined =>
  result === 'refused'
    ? 'jzh: the seatbelt cannot be applied inside another sandbox; commands will be refused. ' +
      'Run outside it, or pass sandbox: none.'
    : undefined

/**
 * Wraps commands with sandbox-exec on macOS. The mode decides what the command
 * may write: `workspace-write` adds the directory it runs in and the temp dir,
 * `read-only` adds neither, and `danger-full-access` leaves the command as it is.
 */
export function seatbeltSandbox(options: SeatbeltOptions): SandboxShape {
  return {
    name: 'seatbelt',
    confines: true,
    enforcement: 'full',
    mode: options.mode,
    wrap: (command) =>
      wrapForProvider(
        command,
        options.mode,
        options.writableRoots,
        DENIAL_SIGNATURES,
        (_mode, writableRoots) => [
          'sandbox-exec',
          '-p',
          seatbeltProfile({ ...options, writableRoots }),
          '--',
          ...command.argv,
        ],
      ),
  }
}
