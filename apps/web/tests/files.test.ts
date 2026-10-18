import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { searchWorkspaceFiles } from '../src/server/files.ts'

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
