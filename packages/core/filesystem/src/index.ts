import { Context, Effect } from 'effect'

/** Why a file operation failed. A tool maps these onto its own vocabulary. */
export interface FileSystemFailure {
  readonly code: 'not-found' | 'denied' | 'io'
  readonly message: string
}

/** What a path is now. The fields a tool needs; a browser store fills the same ones. */
export interface FileStat {
  readonly size: number
  readonly mtimeMs: number
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
  /** The permission bits, or the default a store keeps when it has none. */
  readonly mode: number
}

/** One name in a directory, as a walker asks for it. */
export interface DirEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
}

/**
 * What one look at a path saw: enough to notice that it changed afterwards. The
 * digest is a fingerprint of the bytes rather than a promise of SHA-256, so a
 * store without a hash function can answer it too.
 */
export interface Observation {
  readonly bytes: number
  readonly mtimeMs: number
  readonly digest: string
}

/** A complete file waiting beside its target for the write that publishes it. */
export interface StagedFile {
  /** Replaces the target with the staged bytes; the only step that changes it. */
  readonly commit: Effect.Effect<void, FileSystemFailure>
  /** Removes the staged bytes. Safe after a commit or a second discard. */
  readonly discard: Effect.Effect<void>
}

/**
 * Every file operation a tool may make. The Node implementation answers from the
 * disk; the memory implementation answers from a map, which is what a browser
 * run has. Nothing above this seam names a Node module.
 */
export interface FileSystemShape {
  /** The bytes of one file; a caller that wants text decodes them itself. */
  readBytes(path: string): Effect.Effect<Uint8Array, FileSystemFailure>
  /** The path's state now, or undefined when the path is missing; never a failure. */
  stat(path: string): Effect.Effect<FileStat | undefined>
  /** The names directly under a directory; a missing directory reads as empty. */
  readdir(path: string): Effect.Effect<ReadonlyArray<DirEntry>>
  /** Creates the directory and its parents; an existing directory is not a failure. */
  mkdirp(path: string): Effect.Effect<void, FileSystemFailure>
  /**
   * Writes the bytes beside the target and returns the step that publishes them.
   * The caller re-checks the target between staging and commit, so a change made
   * in that window still refuses the write while the old file stays intact.
   */
  stage(path: string, content: string): Effect.Effect<StagedFile, FileSystemFailure>
  /**
   * What the path holds now, or undefined when it holds nothing. A file that
   * exists but cannot be read still gets an observation with a digest of
   * `'unreadable'`, so it never looks like new work a write may create.
   */
  observe(path: string): Effect.Effect<Observation | undefined>
  /**
   * Synchronous because a path is confined before any file is opened, and some
   * of the tools that confine a path never touch the asynchronous seam at all.
   */
  lstat(path: string): FileStat | undefined
}

/** The file seam a tool runs against. `@jozo-harness/filesystem/node` or `memory` provides it. */
export class FileSystem extends Context.Service<FileSystem, FileSystemShape>()(
  'jozo-harness/FileSystem',
) {}

/** Runs a body that reads the file seam against one implementation. */
export const withFileSystem = <A, E>(
  fileSystem: FileSystemShape,
  body: Effect.Effect<A, E, FileSystem>,
): Effect.Effect<A, E> => body.pipe(Effect.provideService(FileSystem, fileSystem))
