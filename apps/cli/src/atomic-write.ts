import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AtomicWriteOptions {
  /** Permission bits for the replacement; an existing target lends its own when omitted. */
  readonly mode?: number
}

/** The mode of the file at this path, or undefined when there is no file to carry it from. */
const modeOf = (path: string): number | undefined => {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return undefined
  }
}

/**
 * Writes the text to a sibling of the path and renames it over the target, so a
 * reader sees either the old complete file or the new complete one. The
 * temporary inode carries the mode from the start, so a secrets file is never
 * readable under the process umask while it is being replaced. A rename that
 * cannot complete leaves the target as it was and removes the sibling.
 *
 * Windows can report a transient `EACCES`/`EBUSY`/`EPERM` from a replacement
 * another process is looking at; jzh runs on macOS and Linux for now, so the
 * call reports that failure instead of waiting it out.
 */
export function writeFileAtomic(
  path: string,
  text: string,
  options: AtomicWriteOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true })
  const mode = options.mode ?? modeOf(path)
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp'
  try {
    writeFileSync(temporary, text, {
      // A fresh inode opened exclusively cannot follow a symlink planted at the sibling's name.
      flag: 'wx',
      ...(mode === undefined ? {} : { mode }),
    })
    renameSync(temporary, path)
  } catch (cause) {
    rmSync(temporary, { force: true })
    throw cause
  }
}
