import { createHash, randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Effect } from 'effect'
import type {
  DirEntry,
  FileStat,
  FileSystemFailure,
  FileSystemShape,
  Observation,
  StagedFile,
} from './index.ts'

/** The failure a Node call produced, with the code the seam names. */
const failure = (path: string, error: unknown): FileSystemFailure => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? 'not-found'
      : 'io'
  return { code, message: 'cannot read ' + path }
}

const statOf = (info: {
  readonly size: number
  readonly mtimeMs: number
  readonly mode: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): FileStat => ({
  size: info.size,
  mtimeMs: info.mtimeMs,
  mode: info.mode,
  isFile: info.isFile(),
  isDirectory: info.isDirectory(),
  isSymbolicLink: info.isSymbolicLink(),
})

const entryOf = (entry: {
  readonly name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): DirEntry => ({
  name: entry.name,
  isFile: entry.isFile(),
  isDirectory: entry.isDirectory(),
  isSymbolicLink: entry.isSymbolicLink(),
})

/**
 * Writes the bytes to `.tmp-<pid>-<random>` in the target directory and fsyncs
 * them before returning. The rename publishes them; until then the old file is
 * the one a reader sees.
 */
const stage = (path: string, content: string): Effect.Effect<StagedFile, FileSystemFailure> =>
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
      catch: () => ({ code: 'io', message: 'cannot write ' + path }) as FileSystemFailure,
    }).pipe(Effect.onError(() => (created ? discard : Effect.void)))
    const commit = Effect.tryPromise({
      try: () => rename(temp, path),
      catch: () => ({ code: 'io', message: 'cannot write ' + path }) as FileSystemFailure,
    }).pipe(Effect.onError(() => discard))
    return { commit, discard }
  })

/** The disk, through the seam. Every Node-side caller of the tools uses this one. */
export const nodeFileSystem: FileSystemShape = {
  readBytes: (path) =>
    Effect.tryPromise({
      try: () => readFile(path).then((bytes) => new Uint8Array(bytes)),
      catch: (error) => failure(path, error),
    }),
  stat: (path) => Effect.promise(() => stat(path).then(statOf, () => undefined)),
  readdir: (path) =>
    Effect.promise(() =>
      readdir(path, { withFileTypes: true }).then(
        (entries) => entries.map(entryOf),
        () => [],
      ),
    ),
  mkdirp: (path) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }).then(() => undefined),
      catch: () => ({ code: 'io', message: 'cannot create ' + path }) as FileSystemFailure,
    }),
  stage,
  observe: (path) =>
    Effect.promise(async () => {
      const info = await stat(path).catch(() => undefined)
      if (info === undefined) return undefined
      const bytes = await readFile(path).catch(() => undefined)
      if (bytes === undefined) {
        return info.isFile()
          ? { bytes: info.size, mtimeMs: info.mtimeMs, digest: 'unreadable' }
          : undefined
      }
      return {
        bytes: bytes.byteLength,
        mtimeMs: info.mtimeMs,
        digest: createHash('sha256').update(bytes).digest('hex'),
      } satisfies Observation
    }),
  lstat: (path) => {
    const info = lstatSync(path, { throwIfNoEntry: false })
    return info === undefined ? undefined : statOf(info)
  },
}
