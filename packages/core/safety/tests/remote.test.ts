import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  remoteBwrapArgs,
  remoteProgram,
  remoteSandbox,
  remoteWritableRoots,
} from '../src/remote.ts'

/** A stand-in for the ssh invocation: the program is wrapped in a shell here. */
const reach = (program: string): ReadonlyArray<string> => ['ssh', 'box', 'sh', '-c', program]

const wrapped = (options: Parameters<typeof remoteSandbox>[0], argv: ReadonlyArray<string>) => {
  const sandbox = remoteSandbox(options)
  return Effect.runPromise(
    sandbox.wrap({
      argv,
      cwd: options.cwd,
      ...(options.confines ? {} : { mode: 'danger-full-access' as const }),
    }),
  )
}

describe('remoteWritableRoots', () => {
  test('workspace-write adds the workspace and the host temp dir', () => {
    expect(remoteWritableRoots('workspace-write', '/srv/work', [])).toEqual(['/srv/work', '/tmp'])
  })

  test('read-only adds neither, and a standing root still counts', () => {
    expect(remoteWritableRoots('read-only', '/srv/work', ['/srv/cache'])).toEqual(['/srv/cache'])
  })
})

describe('remoteBwrapArgs', () => {
  test('binds the host root read-only and the roots writable', () => {
    const args = remoteBwrapArgs(['/srv/work'])

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
      '--bind-try',
      '/srv/work',
      '/srv/work',
      '--',
    ])
  })

  test('a root named twice is bound once', () => {
    expect(
      remoteBwrapArgs(['/srv/work', '/srv/work']).filter((word) => word === '/srv/work'),
    ).toEqual(['/srv/work', '/srv/work'])
  })
})

describe('remoteProgram', () => {
  test('changes to the directory the call named and runs the command there', () => {
    expect(
      remoteProgram(
        { argv: ['bash', '-lc', 'pwd'], cwd: '/srv/work' },
        '/srv/work',
        'danger-full-access',
        [],
        false,
      ),
    ).toBe("cd '/srv/work' && exec 'bash' '-lc' 'pwd'")
  })

  test('workspace-write starts bwrap on the host with the workspace bound', () => {
    const program = remoteProgram(
      { argv: ['bash', '-lc', 'echo hi'], cwd: '/srv/work' },
      '/srv/work',
      'workspace-write',
      [],
      true,
    )

    expect(program).toContain("exec 'bwrap' '--ro-bind' '/' '/'")
    expect(program).toContain("'--bind-try' '/srv/work' '/srv/work'")
    // The command is one word past `sh -c`, so its own flags stay its own.
    expect(program).toContain("'sh' '-c'")
    expect(program).toContain('echo hi')
  })

  test("a command's own quote survives as one quoted word", () => {
    const program = remoteProgram(
      { argv: ['bash', '-lc', "echo 'one two'"], cwd: '/srv/work' },
      '/srv/work',
      'read-only',
      [],
      true,
    )

    // The quote is escaped once for the outer `sh -c`, so the command sees it.
    expect(program).toContain("'\\''one two'\\''")
  })
})

describe('the remote sandbox', () => {
  test('a confined host hands back the ssh invocation and keeps the mode', async () => {
    const confined = await wrapped(
      { reach: reach, cwd: '/srv/work', mode: 'workspace-write', confines: true },
      ['bash', '-lc', 'echo hi'],
    )

    expect(confined.argv.slice(0, 2)).toEqual(['ssh', 'box'])
    expect(confined.argv.at(-1)).toContain('bwrap')
    expect(confined.mode).toBe('workspace-write')
    expect(confined.denialSignatures).toContain('read-only file system')
  })

  test('danger-full-access runs the command without bwrap', async () => {
    const open = await wrapped(
      { reach: reach, cwd: '/srv/work', mode: 'danger-full-access', confines: true },
      ['bash', '-lc', 'echo hi'],
    )

    // The program is quoted once more for the host's shell, which is what ssh
    // hands its arguments to.
    expect(open.argv.at(-1)).toBe(
      "'cd '\\''/srv/work'\\'' && exec '\\''bash'\\'' '\\''-lc'\\'' '\\''echo hi'\\'''",
    )
    expect(open.mode).toBe('danger-full-access')
    expect(open.denialSignatures).toEqual([])
  })

  test('a host with no bwrap confines nothing and says so', async () => {
    const sandbox = remoteSandbox({
      reach: reach,
      cwd: '/srv/work',
      mode: 'workspace-write',
      confines: false,
    })
    const plain = await Effect.runPromise(
      sandbox.wrap({ argv: ['bash', '-lc', 'echo hi'], cwd: '/srv/work' }),
    )

    expect(sandbox.confines).toBe(false)
    expect(sandbox.mode).toBe('danger-full-access')
    expect(plain.argv.at(-1)).not.toContain('bwrap')
  })
})
