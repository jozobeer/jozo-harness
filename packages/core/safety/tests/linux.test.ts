import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { bwrapArgs, bwrapSandbox, commandRuns, probeBwrap } from '../src/index.ts'

describe('bwrapArgs', () => {
  test('makes the host root read-only and gives the command its own /dev and /proc', () => {
    const args = bwrapArgs([])

    expect(args).toEqual([
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--unshare-pid',
      '--die-with-parent',
      '--',
    ])
  })

  test('a writable root is bound onto itself', () => {
    const args = bwrapArgs(['/work', '/tmp/out'])

    expect(args.join(' ')).toContain('--bind-try /work /work')
    expect(args.join(' ')).toContain('--bind-try /tmp/out /tmp/out')
    expect(args.at(-1)).toBe('--')
  })

  test('read-only names no writable root the profile did not ask for', () => {
    expect(bwrapArgs([])).not.toContain('--bind-try')
  })
})

describe('commandRuns', () => {
  test('reads a real command exit status and treats a missing one as unusable', () => {
    expect(commandRuns([process.execPath, '-e', ''])).toBe(true)
    expect(commandRuns([process.execPath, '-e', 'process.exit(3)'])).toBe(false)
    expect(commandRuns(['jzh-command-that-does-not-exist'])).toBe(false)
  })
})

describe('probeBwrap', () => {
  test('asks for the version and then runs a minimal command inside', () => {
    const calls: string[][] = []
    const usable = probeBwrap((argv) => {
      calls.push([...argv])
      return true
    })

    expect(usable).toBe(true)
    expect(calls[0]).toEqual(['bwrap', '--version'])
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        'bwrap',
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--',
      ]),
    )
    expect(calls[1]?.at(-1)).toBe('true')
  })

  test('a bwrap that cannot build its namespaces is not usable', () => {
    const usable = probeBwrap((argv) => argv[1] === '--version')

    expect(usable).toBe(false)
  })

  test('a missing bwrap stops at the version probe', () => {
    const calls: string[][] = []
    const usable = probeBwrap((argv) => {
      calls.push([...argv])
      return false
    })

    expect(usable).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('bwrapSandbox', () => {
  test('wraps argv with bwrap and keeps the cwd', async () => {
    const sandbox = bwrapSandbox({ mode: 'workspace-write', writableRoots: ['/work'] })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work' }))

    expect(sandbox.name).toBe('bwrap')
    expect(sandbox.confines).toBe(true)
    expect(sandbox.enforcement).toBe('full')
    expect(wrapped.argv[0]).toBe('bwrap')
    expect(wrapped.argv.slice(-3)).toEqual(['--', 'echo', 'hi'])
    expect(wrapped.cwd).toBe('/work')
  })

  test('workspace-write lets a command write where it runs and in the temp dir', async () => {
    const sandbox = bwrapSandbox({ mode: 'workspace-write', writableRoots: [] })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['bash', '-c', 'echo hi'], cwd: '/work/project' }),
    )

    expect(wrapped.argv.join(' ')).toContain('--bind-try /work/project /work/project')
    expect(wrapped.argv.join(' ')).toContain('--bind-try ' + tmpdir() + ' ' + tmpdir())
  })

  test('read-only writes nowhere the command happens to run', async () => {
    const sandbox = bwrapSandbox({ mode: 'read-only', writableRoots: [] })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['bash', '-c', 'echo hi'], cwd: '/work/project' }),
    )

    expect(wrapped.argv).not.toContain('--bind-try')
  })

  test('read-only still honours a root the profile named as writable', async () => {
    const sandbox = bwrapSandbox({ mode: 'read-only', writableRoots: ['/work/out'] })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['bash', '-c', 'echo hi'], cwd: '/work/project' }),
    )

    expect(wrapped.argv.join(' ')).toContain('--bind-try /work/out /work/out')
    expect(wrapped.argv.join(' ')).not.toContain('/work/project /work/project')
  })

  test('danger-full-access runs the command with no sandbox at all', async () => {
    const sandbox = bwrapSandbox({ mode: 'danger-full-access', writableRoots: ['/work'] })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work' }))

    expect(wrapped).toEqual({
      argv: ['echo', 'hi'],
      cwd: '/work',
      mode: 'danger-full-access',
      denialSignatures: [],
    })
  })

  test('one command may run under a wider mode than the standing one', async () => {
    const sandbox = bwrapSandbox({ mode: 'read-only', writableRoots: [] })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work/project', mode: 'workspace-write' }),
    )

    expect(wrapped.mode).toBe('workspace-write')
    expect(wrapped.argv.join(' ')).toContain('--bind-try /work/project /work/project')
  })

  test('a wrapped command names the words a denial is printed with', async () => {
    const sandbox = bwrapSandbox({ mode: 'workspace-write', writableRoots: [] })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work' }))

    expect(wrapped.denialSignatures).toEqual(['read-only file system'])
  })
})
