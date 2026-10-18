import { HooksLive } from '@jozo-harness/kernel'
import { noneSandbox, type ApprovalShape, type SandboxShape } from '@jozo-harness/safety'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { makeWorktreeTool, type WorktreeHost, type WorktreeRun } from '../src/index.ts'

const run = promisify(execFile)

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
  cwd: string,
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'c1',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd, callId: 'c1' },
      })
    }),
  )

/** A sandbox that confines writes to the workspace, like the shipped profile. */
const confined: SandboxShape = {
  name: 'test-confine',
  confines: true,
  mode: 'workspace-write',
  wrap: (command) =>
    Effect.succeed({ ...command, mode: command.mode ?? 'workspace-write', denialSignatures: [] }),
}

const recordingHost = (root: string, overrides: Partial<WorktreeHost> = {}) => {
  const changed: Array<{ sessionId: string; cwd: string; root: string }> = []
  const host: WorktreeHost = {
    rootOf: () => root,
    change: (sessionId, cwd, nextRoot) =>
      Effect.sync(() => void changed.push({ sessionId, cwd, root: nextRoot })),
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    ...overrides,
  }
  return { host, changed }
}

describe('create_worktree tool', () => {
  test('creates a worktree on a new branch and moves the session into it', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'jozo-harness-worktree-')))
    await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    await run('git', ['config', 'user.name', 'Test'], { cwd: dir })
    await writeFile(join(dir, 'README.md'), 'base\n')
    await run('git', ['add', 'README.md'], { cwd: dir })
    await run('git', ['commit', '-qm', 'base'], { cwd: dir })
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    const tree = join(dirname(dir), basename(dir) + '-side')
    const { host, changed } = recordingHost(dir)
    const tool = makeWorktreeTool(noneSandbox, undefined, host)

    const result = await Effect.runPromise(call(tool, { branch: 'side' }, dir))

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual({ cwd: tree, branch: 'side', base: 'HEAD', repo: dir })
    expect(changed).toEqual([{ sessionId: 's1', cwd: tree, root: tree }])
    expect(
      (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tree })).stdout.trim(),
    ).toBe('side')
    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: tree })).stdout.trim()).toBe(head)
    // The original checkout stays where it was, on the commit it was on.
    expect(
      (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim(),
    ).toBe('main')
    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()).toBe(head)
    expect((await run('git', ['status', '--porcelain'], { cwd: dir })).stdout).toBe('')
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('base\n')

    await run('git', ['worktree', 'remove', '--force', tree], { cwd: dir })
    await rm(dir, { recursive: true, force: true })
  })

  test('runs every git command with lazy fetch off and a generated branch name', async () => {
    const seen: Array<{ argv: ReadonlyArray<string>; cwd: string; env: NodeJS.ProcessEnv }> = []
    const runGit = (command: {
      argv: ReadonlyArray<string>
      cwd: string
      env: NodeJS.ProcessEnv
    }) => {
      seen.push({ argv: command.argv, cwd: command.cwd, env: command.env })
      const isTop = command.argv.includes('rev-parse')
      const value: WorktreeRun = {
        exitCode: 0,
        stdout: isTop ? '/work\n' : '',
        stderr: '',
        denialSignatures: [],
      }
      return Effect.succeed(value)
    }
    const { host, changed } = recordingHost('/work', { run: runGit })
    const tool = makeWorktreeTool(confined, undefined, host)
    const tree = join('/work', 'trees', 'generated')

    const result = await Effect.runPromise(call(tool, { path: tree }, '/work'))

    expect(result?.isError).toBe(false)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.argv).toEqual(['git', '-C', '/work', 'rev-parse', '--show-toplevel'])
    expect(seen[1]?.argv).toEqual([
      'git',
      '-C',
      '/work',
      'worktree',
      'add',
      '-b',
      'worktree-20260102-030405',
      tree,
      'HEAD',
    ])
    expect(seen.every((command) => command.env.GIT_NO_LAZY_FETCH === '1')).toBe(true)
    expect(seen[1]?.cwd).toBe('/work')
    expect(changed).toEqual([{ sessionId: 's1', cwd: tree, root: tree }])
  })

  test('refuses a worktree outside the workspace until the call is escalated', async () => {
    const ran: Array<string> = []
    const runGit = (command: { argv: ReadonlyArray<string> }) => {
      ran.push(command.argv.join(' '))
      return Effect.succeed({
        exitCode: 0,
        stdout: '/work\n',
        stderr: '',
        denialSignatures: [],
      })
    }
    const approval: ApprovalShape = {
      serve: () => Effect.void,
      stopServing: () => Effect.void,
      served: () => true,
      request: () => Effect.succeed(false),
    }
    const { host } = recordingHost('/work', { run: runGit })
    const tool = makeWorktreeTool(confined, approval, host)

    const result = await Effect.runPromise(call(tool, { branch: 'side' }, '/work'))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('escapes the workspace')
    expect(JSON.stringify(result?.content)).toContain('[sandbox: escalation available')
    expect(ran).toHaveLength(1)
    expect(ran[0]).not.toContain('worktree add')
  })

  test('asks the approval seam before writing outside the workspace', async () => {
    const asked: Array<string> = []
    const approval: ApprovalShape = {
      serve: () => Effect.void,
      stopServing: () => Effect.void,
      served: () => true,
      request: (request) =>
        Effect.sync(() => {
          asked.push(request.reason)
          return false
        }),
    }
    const { host } = recordingHost('/work')
    const tool = makeWorktreeTool(confined, approval, host)

    const result = await Effect.runPromise(
      call(
        tool,
        {
          branch: 'side',
          sandbox_permissions: 'danger-full-access',
          justification: 'a sibling worktree cannot live inside the workspace',
        },
        '/work',
      ),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('the user rejected escalating')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('a sibling worktree')
  })

  test('runs a rejected sibling path with full access once the human approves', async () => {
    let mode = ''
    const runGit = (command: { mode: string; argv: ReadonlyArray<string> }) => {
      if (command.argv.includes('rev-parse')) {
        return Effect.succeed({
          exitCode: 0,
          stdout: '/work\n',
          stderr: '',
          denialSignatures: [],
        })
      }
      mode = command.mode
      return Effect.succeed({
        exitCode: 0,
        stdout: '',
        stderr: '',
        denialSignatures: [],
      })
    }
    const approval: ApprovalShape = {
      serve: () => Effect.void,
      stopServing: () => Effect.void,
      served: () => true,
      request: () => Effect.succeed(true),
    }
    const { host, changed } = recordingHost('/work', { run: runGit })
    const tool = makeWorktreeTool(confined, approval, host)

    const result = await Effect.runPromise(
      call(
        tool,
        {
          branch: 'side',
          sandbox_permissions: 'danger-full-access',
          justification: 'a sibling worktree cannot live inside the workspace',
        },
        '/work',
      ),
    )

    expect(result?.isError).toBe(false)
    expect(mode).toBe('danger-full-access')
    expect(changed).toHaveLength(1)
  })

  test('refuses a branch name git would read as an option', async () => {
    const { host } = recordingHost('/work')
    const tool = makeWorktreeTool(noneSandbox, undefined, host)

    const result = await Effect.runPromise(call(tool, { branch: '--force' }, '/work'))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('branch name')
  })

  test('reports what git said when it cannot create the worktree', async () => {
    const runGit = (command: { argv: ReadonlyArray<string> }) =>
      Effect.succeed({
        exitCode: command.argv.includes('rev-parse') ? 0 : 128,
        stdout: command.argv.includes('rev-parse') ? '/work\n' : '',
        stderr: command.argv.includes('rev-parse') ? '' : 'fatal: already exists',
        denialSignatures: [],
      })
    const { host } = recordingHost('/work', { run: runGit })
    const tool = makeWorktreeTool(confined, undefined, host)

    const result = await Effect.runPromise(
      call(tool, { branch: 'side', path: join('/work', 'trees', 'side') }, '/work'),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('fatal: already exists')
  })
})
