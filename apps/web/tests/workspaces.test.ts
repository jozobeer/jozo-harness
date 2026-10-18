import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { listDirectories } from '../src/server/index.ts'

describe('the workspace browser', () => {
  test('lists the folders inside a path and the folder it came from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-browse-'))
    await mkdir(join(root, 'beta'))
    await mkdir(join(root, 'alpha'))
    await writeFile(join(root, 'notes.txt'), 'a file is not a folder')
    try {
      const view = await listDirectories(root, '/fallback')
      expect(view.path).toBe(root)
      expect(view.parent).toBe(dirname(root))
      // By name, and only folders: the file in the same place is not offered.
      expect(view.items).toEqual([join(root, 'alpha'), join(root, 'beta')])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('starts at the fallback for an empty path and stops at the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-browse-start-'))
    try {
      const view = await listDirectories('', root)
      expect(view.path).toBe(root)
      const atRoot = await listDirectories('/', '/fallback')
      expect(atRoot.path).toBe('/')
      expect(atRoot.parent).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses a relative path, a file, and a folder that is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-browse-refused-'))
    const file = join(root, 'notes.txt')
    await writeFile(file, 'not a folder')
    try {
      await expect(listDirectories('relative/path', root)).rejects.toThrow(
        'a folder to browse must be absolute',
      )
      await expect(listDirectories(file, root)).rejects.toThrow(
        'a folder to browse must be a directory',
      )
      await expect(listDirectories(join(root, 'missing'), root)).rejects.toThrow(
        'no such directory',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
