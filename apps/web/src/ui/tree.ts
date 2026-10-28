import type { WorkspaceEntry } from '../shared/rpc.ts'
import type { WorkspaceTree } from './state.ts'

/** One row the tree draws: the entry, the name it is known by, and how deep it sits. */
export interface TreeRow {
  /** The path relative to the workspace root, which is also what an @ reference carries. */
  readonly path: string
  readonly name: string
  readonly kind: WorkspaceEntry['kind']
  /** How many folders above it are open; the root's children sit at 0. */
  readonly depth: number
}

/** The name the tree calls one entry by: the workspace root is the empty prefix. */
export const treePathOf = (folder: string, name: string): string =>
  folder === '' ? name : folder + '/' + name

/** Whether a folder shows its children. */
export const treeOpen = (tree: WorkspaceTree | undefined, path: string): boolean =>
  tree?.open.includes(path) === true

/**
 * The rows the tree draws, in reading order: an opened folder's entries follow
 * it, one level deeper. Only what the page has read is drawn, so a folder the
 * reader has not opened yet costs no row and no read.
 */
export const treeRows = (tree: WorkspaceTree | undefined): ReadonlyArray<TreeRow> => {
  if (tree === undefined) return []
  const rows: Array<TreeRow> = []
  const walk = (folder: string, depth: number): void => {
    const read = tree.folders.find((one) => one.path === folder)
    if (read === undefined) return
    for (const entry of read.entries) {
      const path = treePathOf(folder, entry.name)
      rows.push({ path, name: entry.name, kind: entry.kind, depth })
      if (entry.kind === 'directory' && treeOpen(tree, path)) walk(path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

/** Whether any folder the tree shows holds more entries than one listing carries. */
export const treeTruncated = (tree: WorkspaceTree | undefined): boolean =>
  tree?.folders.some((one) => one.truncated) === true
