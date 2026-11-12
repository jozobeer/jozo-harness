import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SandboxError, type SandboxMode, type SandboxShape } from '@jozo-harness/safety'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { confineCwd } from '../src/index.ts'

const sandbox = (mode: SandboxMode): SandboxShape => ({
  name: 'probe',
  confines: mode !== 'danger-full-access',
  mode,
  wrap: () => Effect.fail(new SandboxError({ message: 'the cwd check does not run a command' })),
})

describe('confineCwd', () => {
  test('keeps the workspace when no directory is named', async () => {
    const cwd = await Effect.runPromise(confineCwd('/work', undefined))

    expect(cwd).toBe('/work')
  })

  test('accepts the workspace root and a directory inside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jzh-cwd-'))
    try {
      await mkdir(join(root, 'nested'))

      const same = await Effect.runPromise(confineCwd(root, root))
      const dot = await Effect.runPromise(confineCwd(root, '.'))
      const nested = await Effect.runPromise(confineCwd(root, 'nested'))

      expect(same).toBe(root)
      expect(dot).toBe(root)
      expect(nested).toBe(join(root, 'nested'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses a path that leaves the workspace', async () => {
    const error = await Effect.runPromise(Effect.flip(confineCwd('/work', '/elsewhere')))

    expect(error.code).toBe('denied')
    expect(error.message).toContain('path escapes the workspace')
  })

  test('refuses a link that points out of the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jzh-cwd-'))
    const outside = await mkdtemp(join(tmpdir(), 'jzh-out-'))
    try {
      await symlink(outside, join(root, 'link'))

      const error = await Effect.runPromise(Effect.flip(confineCwd(root, 'link')))

      expect(error.code).toBe('denied')
      expect(error.message).toContain('goes through a link')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('read-only still allows a directory inside the workspace', async () => {
    const cwd = await Effect.runPromise(confineCwd('/work', 'nested', sandbox('read-only')))

    expect(cwd).toBe('/work/nested')
  })

  test('danger-full-access accepts a directory outside the workspace', async () => {
    const cwd = await Effect.runPromise(
      confineCwd('/work', '/elsewhere', sandbox('danger-full-access')),
    )

    expect(cwd).toBe(resolve('/elsewhere'))
  })
})
