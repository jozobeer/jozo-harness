import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Effect } from 'effect'
import type { DirectoryView, WorkspaceView } from '../shared/rpc.ts'
import type { WebError } from './errors.ts'

/**
 * Reads the folders inside one folder, for the Add workspace dialog. A blank
 * path starts at the run's own folder; a path that is not an absolute folder is
 * refused before anything is read. Only folders are listed, by name.
 */
export const listDirectories = async (path: string, start: string): Promise<DirectoryView> => {
  const named = path === '' ? start : path
  if (!isAbsolute(named)) throw new Error('a folder to browse must be absolute')
  const cwd = resolve(named)
  const info = await stat(cwd).catch(() => undefined)
  if (info === undefined) throw new Error('no such directory')
  if (!info.isDirectory()) throw new Error('a folder to browse must be a directory')
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => {
    throw new Error('cannot read this directory')
  })
  const items = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(cwd, entry.name))
    .sort((a, b) => a.localeCompare(b))
  const parent = dirname(cwd)
  return { path: cwd, parent: parent === cwd ? null : parent, items }
}

/**
 * The folders a page may start a session in. A folder is offered because a
 * session already lives there or because the reader registered it; the run's own
 * working directory is always the last resort and never goes missing.
 */
export interface WorkspacesPort {
  readonly list: () => Effect.Effect<
    { readonly cwd: string; readonly items: ReadonlyArray<WorkspaceView> },
    WebError
  >
  /** Reads one folder so the Add workspace dialog can offer the folders inside it. */
  readonly browse: (path: string) => Effect.Effect<DirectoryView, WebError>
  /** Registers one more folder; only an absolute, existing directory is accepted. */
  readonly add: (cwd: string) => Effect.Effect<void, WebError>
}
