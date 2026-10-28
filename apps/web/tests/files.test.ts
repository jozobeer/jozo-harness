import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { listWorkspaceDirectory, searchWorkspaceFiles } from '../src/server/files.ts'

const listed = async (root: string, path: string) =>
  Effect.runPromise(listWorkspaceDirectory(root, path))

const names = async (root: string, path: string): Promise<ReadonlyArray<string>> =>
  (await listed(root, path)).entries.map((entry) => entry.name)

const writeFileDeep = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-files-'))
  await writeFileDeep(join(root, 'apps/web/client-solid/components/composer.tsx'), 'export {}')
  await writeFileDeep(join(root, 'packages/ui/src/composer.ts'), 'export {}')
  await writeFileDeep(join(root, 'ignored/comp.ts'), 'export {}')
  await writeFileDeep(join(root, 'node_modules/pkg/comp.ts'), 'export {}')
  await writeFileDeep(join(root, '.github/comp.yml'), 'name: comp')
  await writeFile(join(root, '.gitignore'), 'ignored/\n')
  return root
}

describe('the workspace file search', () => {
  test('a path holding the word is offered, shallowest first', async () => {
    const root = await workspace()
    try {
      const paths = await Effect.runPromise(searchWorkspaceFiles(root, 'comp'))
      expect(paths).toContain('apps/web/client-solid/components/composer.tsx')
      expect(paths).toContain('packages/ui/src/composer.ts')
      // A shorter path that names the word comes before a deeper one.
      expect(paths.indexOf('packages/ui/src/composer.ts')).toBeLessThan(
        paths.indexOf('apps/web/client-solid/components/composer.tsx'),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('gitignore and node_modules never reach the page, dot entries do', async () => {
    const root = await workspace()
    try {
      const paths = await Effect.runPromise(searchWorkspaceFiles(root, 'comp'))
      expect(paths).not.toContain('ignored/comp.ts')
      expect(paths).not.toContain('node_modules/pkg/comp.ts')
      expect(paths).toContain('.github/comp.yml')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the word is case-insensitive, and an empty word offers nothing', async () => {
    const root = await workspace()
    try {
      expect(await Effect.runPromise(searchWorkspaceFiles(root, 'COMP'))).toContain(
        'apps/web/client-solid/components/composer.tsx',
      )
      expect(await Effect.runPromise(searchWorkspaceFiles(root, '  '))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the answer stops at the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-files-'))
    try {
      for (let index = 0; index < 5; index += 1) {
        await writeFileDeep(join(root, 'folder' + String(index) + '/match.ts'), 'export {}')
      }
      expect(await Effect.runPromise(searchWorkspaceFiles(root, 'match', 2))).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the workspace tree', () => {
  test('a folder lists the entries the tree draws, folders first and each by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-tree-'))
    try {
      await writeFileDeep(join(root, 'beta/one.ts'), 'export {}')
      await writeFileDeep(join(root, 'alpha/two.ts'), 'export {}')
      await writeFile(join(root, 'readme.md'), '#')
      await writeFile(join(root, 'b.ts'), 'export {}')
      const view = await listed(root, '')
      expect(view.path).toBe('')
      expect(view.entries).toEqual([
        { name: 'alpha', kind: 'directory' },
        { name: 'beta', kind: 'directory' },
        { name: 'b.ts', kind: 'file' },
        { name: 'readme.md', kind: 'file' },
      ])
      expect(view.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a folder is read by its workspace-relative name when the tree opens it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-tree-'))
    try {
      await writeFileDeep(join(root, 'apps/web/index.html'), '<!doctype html>')
      await writeFileDeep(join(root, 'apps/cli/main.ts'), 'export {}')
      expect(await names(root, 'apps')).toEqual(['cli', 'web'])
      // One level at a time: opening 'apps' does not read what 'apps/web' holds.
      expect(await names(root, 'apps/web')).toEqual(['index.html'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a folder named with a trailing slash is the same folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-tree-'))
    try {
      await writeFileDeep(join(root, 'apps/web/index.html'), '<!doctype html>')
      const view = await listed(root, 'apps/')
      expect(view.path).toBe('apps')
      expect(view.entries).toEqual([{ name: 'web', kind: 'directory' }])
      expect((await listed(root, './')).path).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('gitignore holds and node_modules stays out, while dot entries stay visible', async () => {
    const root = await workspace()
    try {
      const rootNames = await names(root, '')
      expect(rootNames).not.toContain('node_modules')
      expect(rootNames).not.toContain('ignored')
      expect(rootNames).toContain('.github')
      expect(rootNames).toContain('apps')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a path that leaves the workspace is refused instead of listed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-tree-'))
    try {
      await mkdir(join(root, 'inside'), { recursive: true })
      await expect(listed(root, '..')).rejects.toThrow('outside the workspace')
      await expect(listed(root, 'inside/../../..')).rejects.toThrow('outside the workspace')
      await expect(listed(root, '/etc')).rejects.toThrow('outside the workspace')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a link out of the workspace is not offered, a link that stays inside is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-tree-'))
    const outside = await mkdtemp(join(tmpdir(), 'jozo-harness-tree-away-'))
    try {
      await writeFileDeep(join(root, 'real/kept.ts'), 'export {}')
      await writeFileDeep(join(outside, 'secret.ts'), 'export {}')
      await symlink(outside, join(root, 'away'))
      await symlink(join(root, 'real'), join(root, 'toward'))
      const rootNames = await names(root, '')
      expect(rootNames).not.toContain('away')
      expect(rootNames).toContain('toward')
      // A refusal names the reason, so the page can say what happened.
      await expect(listed(root, 'away')).rejects.toThrow('outside the workspace')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a missing folder and a file named as a folder are both refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-tree-'))
    try {
      await writeFile(join(root, 'file.ts'), 'export {}')
      await expect(listed(root, 'missing')).rejects.toThrow('no such folder')
      await expect(listed(root, 'file.ts')).rejects.toThrow('not a folder')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a folder with more entries than one listing carries says it stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-tree-'))
    try {
      for (let index = 0; index < 1_002; index += 1) {
        await writeFile(join(root, 'file-' + String(index) + '.ts'), 'export {}')
      }
      const view = await listed(root, '')
      expect(view.entries).toHaveLength(1_000)
      expect(view.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
