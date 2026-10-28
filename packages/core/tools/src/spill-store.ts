import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import type { SpillImageWriter, SpillWriter } from './spill.ts'

/** Sessions whose spilled text nobody asked for in this long are removed. */
export const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Extensions read_image accepts, keyed by the media type the block carries. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const pathExists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

/**
 * Removes the session directories under `root` whose newest entry is older than
 * `maxAgeMs`. Files directly under the root are not sessions and stay. A missing
 * root has nothing to do, and a session that cannot be removed is left behind
 * rather than failing the caller.
 */
export function pruneSpills(
  root: string,
  maxAgeMs: number,
  now: () => number = Date.now,
): Effect.Effect<void> {
  return Effect.promise(async () => {
    const entries = await readdir(root, { withFileTypes: true }).then(
      (found) => found,
      () => [],
    )
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      const info = await stat(path).then(
        (value) => value,
        () => undefined,
      )
      if (info === undefined || now() - info.mtimeMs <= maxAgeMs) continue
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}

export interface SpillStoreOptions {
  /** The directory that holds one subdirectory per session. It is created 0700. */
  readonly root: string
  readonly sessionId: string
  /** How long an untouched session may keep its spilled text. */
  readonly maxAgeMs?: number
  /** The clock, so a test can age a session. */
  readonly now?: () => number
}

/**
 * Creates a session's directory 0700 and, the first time it appears, clears the
 * sessions that went stale. Both kinds of spill open the same directory, so the
 * cleanup is shared rather than run twice.
 */
const openSession = async (options: SpillStoreOptions, directory: string): Promise<void> => {
  const known = await pathExists(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (known) return
  await Effect.runPromise(
    pruneSpills(options.root, options.maxAgeMs ?? SPILL_MAX_AGE_MS, options.now),
  )
}

const sessionDirectory = (options: SpillStoreOptions): string =>
  join(options.root, options.sessionId)

/**
 * One writer that puts a spilled text under the session that owns it, in a
 * directory only the owner can read. Opening the session for the first time also
 * clears the sessions that went stale, so the area cleans itself up.
 */
export const makeSpillWriter = (options: SpillStoreOptions): SpillWriter => {
  const directory = sessionDirectory(options)
  return (callId, text) =>
    Effect.promise(async () => {
      const path = join(directory, callId + '.txt')
      await openSession(options, directory)
      await writeFile(path, text)
      return path
    })
}

/**
 * Writes an image's bytes, not its base64, so the path read_image opens holds a
 * real image. The file keeps the extension that tells read_image its media type.
 */
export const makeImageSpillWriter = (options: SpillStoreOptions): SpillImageWriter => {
  const directory = sessionDirectory(options)
  return (callId, data, mediaType) =>
    Effect.promise(async () => {
      const extension = IMAGE_EXTENSIONS[mediaType] ?? 'bin'
      const path = join(directory, callId + '.' + extension)
      await openSession(options, directory)
      await writeFile(path, Buffer.from(data, 'base64'))
      return path
    })
}
