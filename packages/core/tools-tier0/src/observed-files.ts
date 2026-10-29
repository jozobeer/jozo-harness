import { Effect } from 'effect'
import { FileSystem, type Observation } from '@jozo-harness/filesystem'
import { ToolError } from '@jozo-harness/tools'

/** What one look at a path saw: enough to notice that it changed afterwards. */
export type FileObservation = Observation

/** What one session has observed about the files it may change. */
export interface ObservedFiles {
  /** Records that this session looked at `path` and saw this. */
  observe(sessionId: string, path: string, file: FileObservation): void
  /** What this session last saw at `path`, if it ever looked. */
  seen(sessionId: string, path: string): FileObservation | undefined
}

/** Builds the observed-file memory of one process; sessions are keyed apart. */
export function makeObservedFiles(): ObservedFiles {
  const bySession = new Map<string, Map<string, FileObservation>>()
  return {
    observe: (sessionId, path, file) => {
      const seen = bySession.get(sessionId) ?? new Map<string, FileObservation>()
      seen.set(path, file)
      bySession.set(sessionId, seen)
    },
    seen: (sessionId, path) => bySession.get(sessionId)?.get(path),
  }
}

/**
 * What the file on disk looks like now, or undefined when it is not there. A
 * regular file that exists but cannot be read still gets an observation, so it
 * never looks like new work that a write may create. The implementation decides
 * how the bytes are fingerprinted; one run never compares two of them.
 */
export const look = (path: string): Effect.Effect<FileObservation | undefined, never, FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    return yield* fileSystem.observe(path)
  })

/** A file this session may not change because somebody else has been there. */
const changed = (path: string): ToolError =>
  new ToolError({
    code: 'denied',
    message: path + ' changed on disk since you read it; read it again before you write',
  })

/**
 * Refuses when the bytes differ, and also when only the mtime does: a touched
 * file may be the same text, but the safe answer is still to read it again.
 */
const unchanged = (
  seen: FileObservation,
  current: FileObservation,
  path: string,
): Effect.Effect<void, ToolError> => {
  if (seen.digest !== current.digest || seen.mtimeMs !== current.mtimeMs) {
    return Effect.fail(changed(path))
  }
  return Effect.void
}

/**
 * Guards a write: a file that exists must have been read in this session and be
 * unchanged since. A file that is not there is new work and needs no guard.
 */
export const guardWrite = (
  observed: ObservedFiles,
  sessionId: string,
  path: string,
): Effect.Effect<void, ToolError, FileSystem> =>
  Effect.gen(function* () {
    const current = yield* look(path)
    if (current === undefined) return
    const seen = observed.seen(sessionId, path)
    if (seen === undefined) {
      return yield* Effect.fail(
        new ToolError({
          code: 'denied',
          message: 'read ' + path + ' before you overwrite it: the file already exists',
        }),
      )
    }
    yield* unchanged(seen, current, path)
  })

/**
 * Guards an edit: the file must have been read in this session and be unchanged
 * since, so an edit never runs over somebody else's work.
 */
export const guardEdit = (
  observed: ObservedFiles,
  sessionId: string,
  path: string,
): Effect.Effect<void, ToolError, FileSystem> =>
  Effect.gen(function* () {
    const seen = observed.seen(sessionId, path)
    if (seen === undefined) {
      return yield* Effect.fail(
        new ToolError({ code: 'denied', message: 'read ' + path + ' before you edit it' }),
      )
    }
    const current = yield* look(path)
    if (current === undefined) {
      return yield* Effect.fail(
        new ToolError({ code: 'denied', message: 'cannot edit ' + path + ': it is not there' }),
      )
    }
    yield* unchanged(seen, current, path)
  })
