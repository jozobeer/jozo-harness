import { describe, expect, test } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { seatbeltProfile, seatbeltSandbox } from '../src/index.ts'

describe('seatbeltProfile', () => {
  test('opens reads by default and closes writes', () => {
    const profile = seatbeltProfile({ writableRoots: ['/work'] })

    expect(profile).toContain('(version 1)')
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).not.toContain('(deny default)')
    expect(profile).not.toContain('file-read')
    expect(profile).toContain('(subpath "/work")')
  })

  test('a profile with no writable roots can still write to /dev/null', () => {
    const profile = seatbeltProfile({ writableRoots: [] })

    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(literal "/dev/null")')
    expect(profile.split('(deny file-write*)')[1] ?? '').not.toContain('(subpath')
  })

  test('the device sinks a command needs are allowed explicitly', () => {
    const profile = seatbeltProfile({ writableRoots: ['/work'] })
    const writes = profile.split('(deny file-write*)')[1] ?? ''

    expect(writes).toContain('(allow file-write*')
    expect(writes).toContain('(literal "/dev/null")')
  })

  test('a symlinked root is named where it points as well', () => {
    const real = mkdtempSync(join(tmpdir(), 'jozo-harness-root-'))
    const link = real + '-link'
    symlinkSync(real, link)
    try {
      const writes = seatbeltProfile({ writableRoots: [link] }).split('(deny file-write*)')[1] ?? ''

      expect(writes).toContain('(subpath "' + link + '")')
      expect(writes).toContain('(subpath "' + realpathSync(link) + '")')
    } finally {
      rmSync(link, { force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })

  test('quotes roots and leaves the network alone', () => {
    const profile = seatbeltProfile({ writableRoots: ['/a "b"'] })

    expect(profile).toContain('(subpath "/a \\"b\\"")')
    // Reads and network are open because the profile allows everything by default;
    // naming the network would be a second, narrower rule to keep in sync.
    expect(profile).not.toContain('network')
  })
})

describe('seatbeltSandbox', () => {
  test('workspace-write lets a command write where it runs and in the temp dir', async () => {
    const sandbox = seatbeltSandbox({ mode: 'workspace-write', writableRoots: [] })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['bash', '-c', 'echo hi'], cwd: '/work/project' }),
    )
    const writes = (wrapped.argv[2] ?? '').split('(deny file-write*)')[1] ?? ''

    expect(sandbox.mode).toBe('workspace-write')
    expect(writes).toContain('(subpath "/work/project")')
    expect(writes).toContain('(subpath "' + tmpdir() + '")')
    expect(writes).toContain('(literal "/dev/null")')
  })

  test('read-only writes nowhere the command happens to run', async () => {
    const sandbox = seatbeltSandbox({ mode: 'read-only', writableRoots: [] })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['bash', '-c', 'echo hi'], cwd: '/work/project' }),
    )
    const profile = wrapped.argv[2] ?? ''
    const writes = profile.split('(deny file-write*)')[1] ?? ''

    expect(sandbox.mode).toBe('read-only')
    expect(writes).toContain('(literal "/dev/null")')
    expect(writes).not.toContain('(subpath "/work/project")')
  })

  test('read-only still honours a root the profile named as writable', async () => {
    const sandbox = seatbeltSandbox({ mode: 'read-only', writableRoots: ['/work/out'] })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['bash', '-c', 'echo hi'], cwd: '/work/project' }),
    )
    const writes = (wrapped.argv[2] ?? '').split('(deny file-write*)')[1] ?? ''

    expect(writes).toContain('(subpath "/work/out")')
    expect(writes).not.toContain('(subpath "/work/project")')
  })

  test('danger-full-access runs the command with no sandbox at all', async () => {
    const sandbox = seatbeltSandbox({ mode: 'danger-full-access', writableRoots: ['/work'] })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work' }))

    expect(sandbox.mode).toBe('danger-full-access')
    expect(wrapped).toEqual({
      argv: ['echo', 'hi'],
      cwd: '/work',
      mode: 'danger-full-access',
      denialSignatures: [],
    })
  })

  test('a wrapped command names the words a denial is printed with', async () => {
    const sandbox = seatbeltSandbox({ mode: 'workspace-write', writableRoots: [] })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work' }))

    expect(wrapped.mode).toBe('workspace-write')
    expect(wrapped.denialSignatures).toEqual(['operation not permitted'])
  })

  test('one command may run under a wider mode than the standing one', async () => {
    const sandbox = seatbeltSandbox({ mode: 'read-only', writableRoots: [] })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work/project', mode: 'workspace-write' }),
    )
    const writes = (wrapped.argv[2] ?? '').split('(deny file-write*)')[1] ?? ''

    expect(writes).toContain('(subpath "/work/project")')
    expect(writes).toContain('(subpath "' + tmpdir() + '")')
  })

  test('wraps argv with sandbox-exec and keeps the cwd', async () => {
    const sandbox = seatbeltSandbox({ mode: 'workspace-write', writableRoots: ['/work'] })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work' }))

    expect(wrapped.argv.slice(0, 4)).toEqual(['sandbox-exec', '-p', wrapped.argv[2] ?? '', '--'])
    expect(wrapped.argv.slice(4)).toEqual(['echo', 'hi'])
    expect(wrapped.argv[2]).toContain('(allow default)')
    expect(wrapped.argv[2]).toContain('(deny file-write*)')
    expect(wrapped.cwd).toBe('/work')
    expect(sandbox.name).toBe('seatbelt')
  })
})
