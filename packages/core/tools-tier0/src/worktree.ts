import { Schema, Effect } from 'effect'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import {
  noneSandbox,
  type ApprovalShape,
  type SandboxMode,
  type SandboxShape,
} from '@jozo-harness/safety'
import { spawn } from '@jozo-harness/process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { deniedFor, escalates, escalationFields, modeOfCall } from './escalation.ts'

/** The git command a worktree tool runs; the runner decides how to confine it. */
export interface WorktreeCommand {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly mode: SandboxMode
}

/** What a git command printed. The denial signatures let the tool tell a refusal from a failure. */
export interface WorktreeRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly denialSignatures: ReadonlyArray<string>
}

/** Runs git for the worktree tool; a test can hand back a recorded run instead. */
export type WorktreeRunner = (command: WorktreeCommand) => Effect.Effect<WorktreeRun, ToolError>

/** The session state a worktree creation reads and moves. */
export interface WorktreeHost {
  /** The workspace root in force for this session. */
  readonly rootOf: (sessionId: string) => string
  /** Records the move and the new root the worktree becomes. */
  readonly change: (sessionId: string, cwd: string, root: string) => Effect.Effect<void, ToolError>
  /** The clock behind a generated branch name; tests fix it. */
  readonly now?: () => number
  /** The git runner; the shipped one wraps git in the sandbox. */
  readonly run?: WorktreeRunner
}

const Parameters = Schema.Struct({
  branch: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The new branch to check out in the worktree. Defaults to worktree-<UTC timestamp>.',
    }),
  ),
  base: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The commit or branch the worktree starts from. Defaults to HEAD.',
    }),
  ),
  path: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'Where to put the worktree. Defaults to a sibling of the repository named <repo>-<branch>. A relative path starts at the repository root.',
    }),
  ),
  ...escalationFields('a worktree creation', 'worktree'),
})

export type CreateWorktreeArgs = Schema.Schema.Type<typeof Parameters>

export interface WorktreeValue {
  readonly cwd: string
  readonly branch: string
  readonly base: string
  readonly repo: string
}

/** Lazy fetch stays off so a partial clone does not reach the network under the call. */
const envOf = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_NO_LAZY_FETCH: '1' })

/** A branch name that reads as a value to git and not as an option. */
const branchNameIsValid = (branch: string): boolean =>
  branch.length > 0 &&
  !branch.startsWith('-') &&
  !/[\s~^:?*[\]\\]/.test(branch) &&
  !branch.includes('..') &&
  !branch.includes('@{') &&
  !branch.endsWith('/') &&
  !branch.endsWith('.lock')

/** A generated name keeps worktrees from colliding when the model names none. */
const generatedBranch = (now: number): string => {
  const iso = new Date(now).toISOString()
  return (
    'worktree-' + iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, '')
  )
}

/** The directory a branch's worktree gets when the model names none. */
const defaultPath = (repo: string, branch: string): string =>
  join(dirname(repo), basename(repo) + '-' + branch.replace(/[^A-Za-z0-9._-]+/g, '-'))

/** Runs git wrapped by the sandbox, the way bash does; output is read after the exit. */
const spawnRunner =
  (sandbox: SandboxShape): WorktreeRunner =>
  (command) =>
    Effect.gen(function* () {
      const wrapped = yield* sandbox
        .wrap(command)
        .pipe(
          Effect.mapError(
            (error) => new ToolError({ code: 'execution', message: 'sandbox: ' + error.message }),
          ),
        )
      const child = yield* Effect.try({
        try: () => spawn([...wrapped.argv], { cwd: wrapped.cwd, env: command.env }),
        catch: () =>
          new ToolError({
            code: 'execution',
            message: 'cannot run git: ' + command.argv.join(' '),
          }),
      })
      const exitCode = yield* Effect.tryPromise({
        try: () => child.exited,
        catch: () => new ToolError({ code: 'execution', message: 'git did not exit' }),
      })
      const [stdout, stderr] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]),
      )
      return { exitCode, stdout, stderr, denialSignatures: wrapped.denialSignatures }
    })

/** The repository root git reports for the directory the session works in. */
const repositoryOf = (
  run: WorktreeRunner,
  cwd: string,
  mode: SandboxMode,
): Effect.Effect<string, ToolError> =>
  Effect.gen(function* () {
    const top = yield* run({
      argv: ['git', '-C', cwd, 'rev-parse', '--show-toplevel'],
      cwd,
      env: envOf(),
      mode,
    })
    if (top.exitCode !== 0) {
      return yield* Effect.fail(
        new ToolError({
          code: 'execution',
          message: 'cannot find the repository root: ' + (top.stderr.trim() || top.stdout.trim()),
        }),
      )
    }
    const repo = top.stdout.trim()
    if (repo === '') {
      return yield* Effect.fail(
        new ToolError({ code: 'execution', message: 'git returned no repository root' }),
      )
    }
    return repo
  })

/** The worktree path and whether it leaves the workspace root. */
const destinationOf = (
  repo: string,
  root: string,
  path: string | undefined,
  branch: string,
): { readonly target: string; readonly escapes: boolean } => {
  const target =
    path === undefined
      ? defaultPath(repo, branch)
      : isAbsolute(path)
        ? resolve(path)
        : resolve(repo, path)
  const inside = relative(root, target)
  const escapes = isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)
  return { target, escapes }
}

/** Why this mode cannot write here, or nothing when it can. */
const refusalOf = (
  mode: SandboxMode,
  target: string,
  escapes: boolean,
  canEscalate: boolean,
): ToolError | undefined => {
  if (mode === 'read-only') {
    return deniedFor('read-only mode writes nothing: ' + target, mode, 'worktree', canEscalate)
  }
  if (escapes && mode !== 'danger-full-access') {
    return deniedFor(
      'worktree path escapes the workspace: ' + target,
      mode,
      'worktree',
      canEscalate,
    )
  }
  return undefined
}

/** What a failed git run means: a sandbox refusal when it signed one, otherwise the failure. */
const failureOf = (
  run: WorktreeRun,
  mode: SandboxMode,
  target: string,
  canEscalate: boolean,
): ToolError | undefined => {
  if (run.exitCode === 0) return undefined
  const lowered = run.stderr.toLowerCase()
  if (run.denialSignatures.some((signature) => lowered.includes(signature.toLowerCase()))) {
    return deniedFor('git could not write the worktree: ' + target, mode, 'worktree', canEscalate)
  }
  return new ToolError({
    code: 'execution',
    message:
      'git worktree add failed: ' +
      (run.stderr.trim() || run.stdout.trim() || 'exit ' + run.exitCode),
  })
}

/**
 * Creates a git worktree on a new branch and moves the session into it. The
 * original checkout keeps its branch and commit: the new tree is a separate
 * directory, and the session's later bash / write / edit calls run there.
 */
export const makeWorktreeTool = (
  sandbox: SandboxShape = noneSandbox,
  approval: ApprovalShape | undefined,
  host: WorktreeHost,
): ToolDefinition<CreateWorktreeArgs, WorktreeValue> => {
  const canEscalate = escalates(sandbox, approval)
  const run = host.run ?? spawnRunner(sandbox)
  const now = host.now ?? (() => Date.now())
  return {
    name: 'create_worktree',
    description:
      'Creates a git worktree on a new branch from a commit and moves the session into it, leaving the original checkout on its branch and commit. Later bash, write, and edit calls run in the new tree. A worktree outside the workspace needs sandbox_permissions and a justification, because creating it writes outside the sandboxed directory.',
    parameters: Parameters,
    output: {
      schema: Schema.Struct({
        cwd: Schema.String,
        branch: Schema.String,
        base: Schema.String,
        repo: Schema.String,
      }),
      render: (_args, value) => [
        {
          type: 'text',
          text:
            'created worktree ' +
            value.cwd +
            ' on branch ' +
            value.branch +
            ' from ' +
            value.base +
            '; working directory is now ' +
            value.cwd,
        },
      ],
    },
    execute: (args, context) =>
      Effect.gen(function* () {
        const mode = yield* modeOfCall({
          args,
          callId: context.callId,
          tool: 'create_worktree',
          subject: 'worktree',
          sandbox,
          approval,
        })
        const base = args.base ?? 'HEAD'
        const branch = args.branch ?? generatedBranch(now())
        if (!branchNameIsValid(branch)) {
          return yield* Effect.fail(
            new ToolError({
              code: 'invalid-arguments',
              message: 'branch name is not something git accepts: ' + branch,
            }),
          )
        }

        const repo = yield* repositoryOf(run, context.cwd, mode)
        const { target, escapes } = destinationOf(
          repo,
          host.rootOf(context.sessionId),
          args.path,
          branch,
        )
        const refusal = refusalOf(mode, target, escapes, canEscalate)
        if (refusal !== undefined) return yield* Effect.fail(refusal)

        const created = yield* run({
          argv: ['git', '-C', repo, 'worktree', 'add', '-b', branch, target, base],
          cwd: repo,
          env: envOf(),
          mode,
        })
        const failure = failureOf(created, mode, target, canEscalate)
        if (failure !== undefined) return yield* Effect.fail(failure)

        yield* host.change(context.sessionId, target, target)
        return { cwd: target, branch, base, repo }
      }),
  }
}
