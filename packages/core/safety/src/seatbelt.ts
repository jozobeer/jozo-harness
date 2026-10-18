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
