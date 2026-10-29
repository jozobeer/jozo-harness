import { describe, expect, test } from 'vitest'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { resolveInside } from '../src/index.ts'

const failure = (result: { _tag: string; failure?: unknown }): string =>
  result._tag === 'Failure'
    ? String((result.failure as { message?: string }).message)
    : 'no failure'

/** A workspace with a link that points out of it, built fresh for one test. */
const withWorkspace = async (
  run: (paths: { readonly root: string; readonly outside: string }) => Promise<void>,
): Promise<void> => {
  const base = await mkdtemp(join(tmpdir(), 'jozo-harness-fs-'))
  const root = join(base, 'work')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  try {
    await run({ root, outside })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

describe('the one place a path becomes a path a tool may use', () => {
  test('a path inside the workspace is taken, absolute or relative', async () => {
    await withWorkspace(async ({ root }) => {
      const relativePath = await Effect.runPromise(
        resolveInside(nodeFileSystem, root, 'src/app.ts'),
      )
      const absolutePath = await Effect.runPromise(
        resolveInside(nodeFileSystem, root, join(root, 'notes.md')),
      )

      expect(relativePath).toBe(join(root, 'src/app.ts'))
      expect(absolutePath).toBe(join(root, 'notes.md'))
    })
  })

  test('a path that leaves the workspace is refused', async () => {
    await withWorkspace(async ({ root, outside }) => {
      const up = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, '../outside/x')),
      )
      const absolute = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, join(outside, 'x'))),
      )
      const sibling = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, root + '-other/x')),
      )
      const itself = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, '.')),
      )

      expect(failure(up)).toContain('escapes the workspace')
      expect(failure(absolute)).toContain('escapes the workspace')
      // A name that merely starts with the workspace is not inside it.
      expect(failure(sibling)).toContain('escapes the workspace')
      expect(failure(itself)).toContain('escapes the workspace')
    })
  })

  test('a path through a link is refused, even when the link points inside', async () => {
    await withWorkspace(async ({ root, outside }) => {
      await symlink(outside, join(root, 'out'))
      await symlink(join(root, 'inside'), join(root, 'in'))
      await mkdir(join(root, 'inside'))

      const throughOut = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, 'out/secret.txt')),
      )
      const underOut = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, 'out/new/secret.txt')),
      )
      const throughIn = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, 'in/note.txt')),
      )

      expect(failure(throughOut)).toContain('goes through a link')
      // Creating the directories first does not make it safe: the link is still there.
      expect(failure(underOut)).toContain('goes through a link')
      expect(failure(throughIn)).toContain('goes through a link')
    })
  })

  test('a file that is itself a link is refused, and a dangling link too', async () => {
    await withWorkspace(async ({ root, outside }) => {
      await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'))
      await symlink(join(outside, 'nowhere.txt'), join(root, 'dangling.txt'))

      const linked = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, 'linked.txt')),
      )
      const dangling = await Effect.runPromise(
        Effect.result(resolveInside(nodeFileSystem, root, 'dangling.txt')),
      )

      expect(failure(linked)).toContain('goes through a link')
      expect(failure(dangling)).toContain('goes through a link')
    })
  })

  test('new work below the workspace is allowed while nothing exists yet', async () => {
    await withWorkspace(async ({ root }) => {
      const path = await Effect.runPromise(resolveInside(nodeFileSystem, root, 'new/deep/file.txt'))

      expect(path).toBe(join(root, 'new/deep/file.txt'))
      expect(existsSync(path)).toBe(false)
    })
  })
})
