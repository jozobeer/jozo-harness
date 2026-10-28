import {
  PROJECTION_CHECKPOINT_VERSION,
  decodeProjectionCheckpoint,
  encodeProjectionCheckpoint,
  type DerivedMessage,
  type ProjectionCheckpoint,
  type SessionError,
  type SessionId,
  type SessionSeq,
} from '@jozo-harness/session'
import { Effect } from 'effect'
import { readFile, rename, rm, stat as statFile, writeFile } from 'node:fs/promises'
import { persistenceError } from './errors.ts'

/** The checkpoint's name beside the log; the version keeps an old layout from loading. */
export const PROJECTION_FILE_NAME = 'projection.v1.json'

/**
 * Reads the projection saved with a log. A missing, torn, or foreign file is a
 * miss: the session then folds the whole log rather than failing to open.
 */
export const readProjection = (
  path: string,
  logPath: string,
): Effect.Effect<ProjectionCheckpoint | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const [text, log] = await Promise.all([readFile(path, 'utf8'), statFile(logPath)])
      const checkpoint = decodeProjectionCheckpoint(JSON.parse(text) as unknown)
      if (checkpoint === undefined) return undefined
      // A log shorter than the one the checkpoint was taken over was replaced or
      // truncated under the same name; the seq may still exist, so compare sizes.
      return log.size < checkpoint.log.size ? undefined : checkpoint
    },
    catch: (cause) => cause,
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

/**
 * Replaces the checkpoint in one rename. The write happens on the side of the
 * log: a crash leaves either the old checkpoint or the new one, never a torn
 * file that the next open would have to parse.
 */
export const writeProjection = (
  path: string,
  logPath: string,
  id: SessionId,
  seq: SessionSeq,
  derived: ReadonlyArray<DerivedMessage>,
): Effect.Effect<void, SessionError> =>
  Effect.tryPromise({
    try: async () => {
      const log = await statFile(logPath)
      const checkpoint: ProjectionCheckpoint = {
        version: PROJECTION_CHECKPOINT_VERSION,
        seq,
        log: { mtimeMs: log.mtimeMs, size: log.size },
        derived,
      }
      const temporary = `${path}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temporary, encodeProjectionCheckpoint(checkpoint))
        await rename(temporary, path)
      } catch (cause) {
        await rm(temporary, { force: true })
        throw cause
      }
    },
    catch: (cause) =>
      persistenceError(`cannot write the projection checkpoint of session ${id}`, cause),
  })
