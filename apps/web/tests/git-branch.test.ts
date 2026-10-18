import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import { branchOf } from '../src/server/git-branch.ts'

/** Every temp directory this file made, removed when the test ends. */
const made: Array<string> = []

const temporary = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-branch-'))
  made.push(dir)
  return dir
}

const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { stdio: 'ignore' },
  )
}

const branchAt = (cwd: string): Promise<string | null> => Effect.runPromise(branchOf(cwd))

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('the branch a workspace stands on', () => {
  test('is the branch git checks out', async () => {
    const dir = await temporary()
    git(dir, 'init', '-q')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(dir, 'checkout', '-q', '-b', 'feature/status-bar')
    expect(await branchAt(dir)).toBe('feature/status-bar')
  })

  test('is the branch a worktree checks out', async () => {
    const dir = await temporary()
    git(dir, 'init', '-q')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'first')
    const tree = join(await temporary(), 'tree')
    git(dir, 'worktree', 'add', '-q', '-b', 'side', tree)
    expect(await branchAt(tree)).toBe('side')
  })

  test('is nothing outside a git workspace', async () => {
    const dir = await temporary()
    expect(await branchAt(dir)).toBeNull()
  })

  test('is nothing on a detached HEAD', async () => {
    const dir = await temporary()
    git(dir, 'init', '-q')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(dir, 'checkout', '-q', '--detach')
    expect(await branchAt(dir)).toBeNull()
  })

  test('is nothing when the directory itself is gone', async () => {
    expect(await branchAt(join(await temporary(), 'missing'))).toBeNull()
  })
})
