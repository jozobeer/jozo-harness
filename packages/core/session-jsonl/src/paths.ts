import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing } from './errors.ts'

/** The plaintext log older sessions keep; a new session never writes it. */
export const SESSION_FILE_NAME = 'session.v1.jsonl'

/** The zstd log a new session writes: one line per frame. */
export const SESSION_ZSTD_FILE_NAME = 'session.v1.jsonl.zst'

export type SessionLogFormat = 'jsonl' | 'zstd'

/** One session's log, and the shape its bytes are in. */
export interface SessionLogFile {
  readonly path: string
  readonly format: SessionLogFormat
}

/** `~` and `~/x` become the home directory; anything else is left as it is. */
export const expandHome = (root: string): string => {
  if (root === '~') return homedir()
  return root.startsWith('~/') ? join(homedir(), root.slice(2)) : root
}

/** Whether a path exists; a permission failure is not a missing log. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (cause) {
    if (isMissing(cause)) return false
    throw cause
  }
}

/**
 * The log a session directory holds. A plaintext log wins when both exist: it is
 * the older generation, and opening it must keep appending plaintext rather than
 * silently switching the session's format under a running build.
 */
export const resolveSessionLog = async (directory: string): Promise<SessionLogFile | undefined> => {
  const plain = join(directory, SESSION_FILE_NAME)
  if (await exists(plain)) return { path: plain, format: 'jsonl' }
  const compressed = join(directory, SESSION_ZSTD_FILE_NAME)
  if (await exists(compressed)) return { path: compressed, format: 'zstd' }
  return undefined
}

/** The log a session created by this build writes. */
export const newSessionLog = (directory: string): SessionLogFile => ({
  path: join(directory, SESSION_ZSTD_FILE_NAME),
  format: 'zstd',
})
