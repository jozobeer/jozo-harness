import { describe, expect, test } from 'vitest'
import type { WorkspaceTree } from '../src/ui/state.ts'
import { treeOpen, treePathOf, treeRows, treeTruncated } from '../src/ui/tree.ts'

const tree = (folders: WorkspaceTree['folders'], open: ReadonlyArray<string>): WorkspaceTree => ({
  folders,
  open,
  problem: '',
})

describe('the workspace tree', () => {
  test('a child is named from the folder it sits in, and the root has no prefix', () => {
    expect(treePathOf('', 'README.md')).toBe('README.md')
    expect(treePathOf('apps', 'web')).toBe('apps/web')
  })

  test('an opened folder puts its entries after it, one level deeper', () => {
    const rows = treeRows(
      tree(
        [
          {
            path: '',
            entries: [
              { name: 'apps', kind: 'directory' },
              { name: 'README.md', kind: 'file' },
            ],
            truncated: false,
          },
          {
            path: 'apps',
            entries: [
              { name: 'web', kind: 'directory' },
              { name: 'main.ts', kind: 'file' },
            ],
            truncated: false,
          },
        ],
        ['', 'apps'],
      ),
    )
    expect(rows.map((row) => row.path + ':' + String(row.depth))).toEqual([
      'apps:0',
      'apps/web:1',
      'apps/main.ts:1',
      'README.md:0',
    ])
  })

  test('a folder the page has not read draws no row for its children', () => {
    const rows = treeRows(
      tree(
        [
          {
            path: '',
            entries: [{ name: 'apps', kind: 'directory' }],
            truncated: false,
          },
        ],
        ['', 'apps'],
      ),
    )
    expect(rows).toEqual([{ path: 'apps', name: 'apps', kind: 'directory', depth: 0 }])
  })

  test('a closed folder keeps its children out of the rows', () => {
    const folders: WorkspaceTree['folders'] = [
      { path: '', entries: [{ name: 'apps', kind: 'directory' }], truncated: false },
      { path: 'apps', entries: [{ name: 'main.ts', kind: 'file' }], truncated: false },
    ]
    expect(treeRows(tree(folders, [''])).map((row) => row.path)).toEqual(['apps'])
    expect(treeRows(tree(folders, ['', 'apps'])).map((row) => row.path)).toEqual([
      'apps',
      'apps/main.ts',
    ])
  })

  test('an unread tree draws nothing and shows no folder as open', () => {
    expect(treeRows(undefined)).toEqual([])
    expect(treeOpen(undefined, '')).toBe(false)
    expect(treeOpen(tree([], ['']), '')).toBe(true)
  })

  test('a tree is truncated when any folder it read holds more than it lists', () => {
    const one = (truncated: boolean): WorkspaceTree =>
      tree([{ path: '', entries: [], truncated }], [''])
    expect(treeTruncated(undefined)).toBe(false)
    expect(treeTruncated(one(false))).toBe(false)
    expect(treeTruncated(one(true))).toBe(true)
  })
})
