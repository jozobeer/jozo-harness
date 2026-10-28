import { randomBytes } from 'node:crypto'
import { open, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Effect } from 'effect'
import { ToolError } from '@jozo-harness/tools'

/** A complete file waiting beside its target for the rename that publishes it. */
export interface StagedFile {
  /** Replaces the target with the staged bytes; the only step that changes it. */
  readonly commit: Effect.Effect<void, ToolError>
  /** Removes the staged bytes. Safe after a commit or a second discard. */
  readonly discard: Effect.Effect<void>
}

/**
 * Writes the bytes to `.tmp-<pid>-<random>` in the target directory and fsyncs
 * them before returning. Callers re-check the target between staging and commit,
 * so a change on disk can still refuse the write while the old file is intact.
 */
export const stageFile = (path: string, content: string): Effect.Effect<StagedFile, ToolError> =>
  Effect.gen(function* () {
    const temp = join(
      dirname(path),
      '.tmp-' + String(process.pid) + '-' + randomBytes(6).toString('hex'),
    )
    const discard = Effect.promise(async () => {
      await unlink(temp).catch(() => undefined)
    })
    let created = false
    // Keep the mode of a file that is being replaced; a rename would otherwise
    // apply the temp file's umask, turning a 0755 script into 0644.
    const mode = yield* Effect.promise(() =>
      stat(path).then(
        (info) => info.mode & 0o777,
        () => 0o666,
      ),
    )
    yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(temp, 'wx', mode)
        created = true
        try {
          await handle.writeFile(content, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
      catch: () => new ToolError({ code: 'execution', message: 'cannot write ' + path }),
    }).pipe(Effect.onError(() => (created ? discard : Effect.void)))
    const commit = Effect.tryPromise({
      try: () => rename(temp, path),
      catch: () => new ToolError({ code: 'execution', message: 'cannot write ' + path }),
    }).pipe(Effect.onError(() => discard))
    return { commit, discard }
  })
