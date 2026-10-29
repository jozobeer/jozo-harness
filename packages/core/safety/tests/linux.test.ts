import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  bwrapArgs,
  bwrapSandbox,
  commandRuns,
  LANDLOCK_HELPER,
  landlockArgs,
  landlockCandidates,
  landlockSandbox,
  probeBwrap,
  probeLandlock,
} from '../src/index.ts'

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

describe('landlockArgs', () => {
  test('names each writable root once', () => {
    expect(landlockArgs(['/work', '/work', '/tmp/out'])).toEqual([
      '--writable-root',
      '/work',
      '--writable-root',
      '/tmp/out',
    ])
  })
})

describe('probeLandlock', () => {
  test('takes the first candidate that applies a ruleset', () => {
    const calls: string[][] = []
    const helper = probeLandlock(
      (argv) => {
        calls.push([...argv])
        return argv[0] === '/opt/landlock-run'
      },
      ['/missing/landlock-run', '/opt/landlock-run', '/later/landlock-run'],
    )

    expect(helper).toBe('/opt/landlock-run')
    expect(calls).toEqual([
      ['/missing/landlock-run', '--probe'],
      ['/opt/landlock-run', '--probe'],
    ])
  })

  test('a helper that cannot apply a ruleset is not usable', () => {
    expect(probeLandlock(() => false, ['/opt/landlock-run'])).toBeUndefined()
  })

  test('looks on PATH first and then in the two cargo build directories', () => {
    const candidates = landlockCandidates()

    expect(candidates[0]).toBe(LANDLOCK_HELPER)
    expect(candidates[1]?.endsWith(join('target', 'release', 'landlock-run'))).toBe(true)
    expect(candidates[2]?.endsWith(join('target', 'debug', 'landlock-run'))).toBe(true)
  })
})

describe('landlockSandbox', () => {
  test('wraps argv with the helper and keeps the cwd', async () => {
    const sandbox = landlockSandbox({
      mode: 'workspace-write',
      writableRoots: [],
      helper: '/opt/landlock-run',
    })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work' }))

    expect(sandbox.name).toBe('landlock')
    expect(sandbox.confines).toBe(true)
    expect(sandbox.enforcement).toBe('full')
    expect(wrapped.argv.slice(0, 2)).toEqual(['/opt/landlock-run', '--writable-root'])
    expect(wrapped.argv).toContain('/work')
    expect(wrapped.argv).toContain(tmpdir())
    expect(wrapped.argv.slice(-3)).toEqual(['--', 'echo', 'hi'])
    expect(wrapped.cwd).toBe('/work')
    expect(wrapped.denialSignatures).toEqual([])
  })

  test('read-only names only the roots the profile asked for', async () => {
    const sandbox = landlockSandbox({
      mode: 'read-only',
      writableRoots: ['/work/out'],
      helper: '/opt/landlock-run',
    })
    const wrapped = await Effect.runPromise(
      sandbox.wrap({ argv: ['bash', '-c', 'echo hi'], cwd: '/work/project' }),
    )

    expect(wrapped.argv).toContain('/work/out')
    expect(wrapped.argv).not.toContain('/work/project')
    expect(wrapped.argv).not.toContain(tmpdir())
  })

  test('danger-full-access runs the command with no helper', async () => {
    const sandbox = landlockSandbox({
      mode: 'danger-full-access',
      writableRoots: ['/work'],
      helper: '/opt/landlock-run',
    })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv: ['echo', 'hi'], cwd: '/work' }))

    expect(wrapped).toEqual({
      argv: ['echo', 'hi'],
      cwd: '/work',
      mode: 'danger-full-access',
      denialSignatures: [],
    })
  })
})

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Where `cargo build` leaves the helper, unless CARGO_TARGET_DIR moves it. */
const helperBinary = join(
  process.env['CARGO_TARGET_DIR'] ?? join(repoRoot, 'target'),
  'debug',
  'landlock-run',
)

/**
 * Landlock is a Linux LSM, so the helper and these tests only run there. macOS
 * confines commands with the seatbelt and covers that backend in its own tests;
 * skipping here is not a way to hide a macOS failure.
 */
describe.skipIf(process.platform !== 'linux')('landlock helper on Linux', () => {
  let scratch = ''

  beforeAll(() => {
    const built = spawnSync('cargo', ['build', '--bin', 'landlock-run'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    expect(built.status).toBe(0)
    scratch = mkdtempSync(join(repoRoot, '.landlock-test-'))
  }, 120_000)

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const run = async (
    mode: 'workspace-write' | 'read-only',
    cwd: string,
    argv: ReadonlyArray<string>,
  ) => {
    const sandbox = landlockSandbox({ mode, writableRoots: [], helper: helperBinary })
    const wrapped = await Effect.runPromise(sandbox.wrap({ argv, cwd }))
    const [file, ...args] = wrapped.argv
    return spawnSync(file ?? '', args, {
      cwd: wrapped.cwd,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    })
  }

  test('writes a file under the cwd and under the temp dir', async () => {
    const cwd = mkdtempSync(join(scratch, 'inside-'))
    const temp = mkdtempSync(join(tmpdir(), 'jzh-landlock-'))

    const inCwd = await run('workspace-write', cwd, ['bash', '-c', 'printf hi > made.txt'])
    const inTemp = await run('workspace-write', cwd, [
      'bash',
      '-c',
      'printf hi > "$1/made.txt"',
      'bash',
      temp,
    ])

    expect(inCwd.status).toBe(0)
    expect(readFileSync(join(cwd, 'made.txt'), 'utf8')).toBe('hi')
    expect(inTemp.status).toBe(0)
    expect(readFileSync(join(temp, 'made.txt'), 'utf8')).toBe('hi')
    rmSync(temp, { recursive: true, force: true })
  })

  test('refuses a write outside the cwd and the temp dir', async () => {
    const cwd = mkdtempSync(join(scratch, 'cwd-'))
    const outside = mkdtempSync(join(scratch, 'outside-'))
    const target = join(outside, 'escaped.txt')

    const result = await run('workspace-write', cwd, [
      'bash',
      '-c',
      'printf hi > "$1"',
      'bash',
      target,
    ])

    expect(result.status).not.toBe(0)
    expect(existsSync(target)).toBe(false)
    expect(String(result.stderr).toLowerCase()).toContain('permission denied')
  })

  test('read-only writes nowhere, not even in the cwd', async () => {
    const cwd = mkdtempSync(join(scratch, 'readonly-'))

    const result = await run('read-only', cwd, ['bash', '-c', 'printf hi > made.txt'])

    expect(result.status).not.toBe(0)
    expect(existsSync(join(cwd, 'made.txt'))).toBe(false)
  })

  test('the probe accepts the built helper and refuses a path that is not there', () => {
    expect(probeLandlock(commandRuns, [helperBinary])).toBe(helperBinary)
    expect(probeLandlock(commandRuns, [join(scratch, 'no-such-helper')])).toBeUndefined()
  })
})
