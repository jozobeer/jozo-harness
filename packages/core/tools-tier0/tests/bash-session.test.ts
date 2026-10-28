import { HooksLive } from '@jozo-harness/kernel'
import {
  makeApproval,
  type ApprovalRequested,
  type ApprovalShape,
  type SandboxShape,
} from '@jozo-harness/safety'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeBashTool, makeShellSessions } from '../src/index.ts'

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
  cwd = '/tmp',
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

const valueOf = (result: ToolExecutionResult | undefined): any => result?.value

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

/** Keeps the shell the call asked for and records the mode the session is bound to. */
const preserving = (): SandboxShape => ({
  name: 'preserving',
  confines: true,
  mode: 'workspace-write',
  wrap: (command) =>
    Effect.succeed({
      argv: [...command.argv],
      cwd: command.cwd,
      mode: command.mode ?? 'workspace-write',
      denialSignatures: [],
    }),
})

/** An approval seam that answers `approved` and records what it was asked. */
const answering = async (approved: boolean): Promise<[ApprovalShape, Array<ApprovalRequested>]> => {
  const asked: Array<ApprovalRequested> = []
  const approval = await Effect.runPromise(makeApproval())
  await Effect.runPromise(
    approval.serve((request) =>
      Effect.sync(() => {
        asked.push(request)
        return approved
      }),
    ),
  )
  return [approval, asked]
}

/** Runs the command twice in one tool instance, so a name can carry state between them. */
const twice = async (
  tool: ToolDefinition<any, any>,
  first: unknown,
  second: unknown,
): Promise<[any, any]> => [
  valueOf(await Effect.runPromise(call(tool, first))),
  valueOf(await Effect.runPromise(call(tool, second))),
]

const gone = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

describe('bash session', () => {
  test('a named session keeps the directory a previous call changed', async () => {
    const sessions = makeShellSessions()
    const tool = makeBashTool(undefined, undefined, undefined, undefined, sessions)
    const [, second] = await twice(
      tool,
      { command: 'cd / && echo moved', session: 'work' },
      { command: 'pwd', session: 'work' },
    )

    expect(second.stdout.trim()).toBe('/')
    sessions.closeAll()
  })

  test('two session names hold two independent shells', async () => {
    const sessions = makeShellSessions()
    const tool = makeBashTool(undefined, undefined, undefined, undefined, sessions)
    const [, second] = await twice(
      tool,
      { command: 'cd / && SHELL_MARK=one; echo first', session: 'one' },
      { command: 'echo "${SHELL_MARK:-none}"; pwd', session: 'two' },
    )

    expect(second.stdout).toBe('none\n' + realpathSync('/tmp') + '\n')
    sessions.closeAll()
  })

  test('a call without a session starts from the caller directory again', async () => {
    const [, second] = await twice(
      makeBashTool(),
      { command: 'cd / && echo moved', session: 'work' },
      { command: 'pwd' },
    )

    expect(second.stdout).toBe(realpathSync('/tmp') + '\n')
  })

  test('closing a run ends the shell and the processes it started', async () => {
    const sessions = makeShellSessions()
    const tool = makeBashTool(undefined, undefined, undefined, undefined, sessions)
    const started = valueOf(
      await Effect.runPromise(call(tool, { command: 'sleep 60 & echo $$ $!', session: 'work' })),
    ) as { stdout: string }
    const pids = started.stdout.trim().split(' ').map(Number)
    const shellPid = pids[0] ?? 0
    const sleeperPid = pids[1] ?? 0

    expect(shellPid).toBeGreaterThan(0)
    expect(sleeperPid).toBeGreaterThan(0)
    sessions.closeAll()

    expect(await gone(shellPid)).toBe(true)
    expect(await gone(sleeperPid)).toBe(true)
  })

  test('a session started with a wider mode does not run a later confined command', async () => {
    const sessions = makeShellSessions()
    const [approval, asked] = await answering(true)
    const tool = makeBashTool(preserving(), approval, undefined, undefined, sessions)
    const first = valueOf(
      await Effect.runPromise(
        call(tool, {
          command: 'MARKER=kept; echo started',
          session: 'work',
          sandbox_permissions: 'danger-full-access',
          justification: 'the install writes outside the workspace',
        }),
      ),
    )

    expect(first.sandbox.mode).toBe('danger-full-access')
    expect(first.stdout).toContain('started')
    expect(asked).toHaveLength(1)

    const second = await Effect.runPromise(
      call(tool, { command: 'echo leaked; MARKER=wiped', session: 'work' }),
    )

    expect(second?.isError).toBe(true)
    expect(textOf(second)).toContain('danger-full-access')
    expect(textOf(second)).not.toContain('leaked')
    expect(asked).toHaveLength(1)

    const third = valueOf(
      await Effect.runPromise(
        call(tool, {
          command: 'echo "$MARKER"',
          session: 'work',
          sandbox_permissions: 'danger-full-access',
          justification: 'the install writes outside the workspace',
        }),
      ),
    )
    expect(third.stdout.trim()).toBe('kept')
    sessions.closeAll()
  })

  test('a confined session refuses a wider mode before asking for approval', async () => {
    const sessions = makeShellSessions()
    const [approval, asked] = await answering(true)
    const tool = makeBashTool(preserving(), approval, undefined, undefined, sessions)
    const first = valueOf(
      await Effect.runPromise(
        call(tool, { command: 'MARKER=kept; echo started', session: 'work' }),
      ),
    )
    expect(first.stdout).toContain('started')

    const second = await Effect.runPromise(
      call(tool, {
        command: 'echo leaked; MARKER=wiped',
        session: 'work',
        sandbox_permissions: 'danger-full-access',
        justification: 'the install writes outside the workspace',
      }),
    )

    expect(second?.isError).toBe(true)
    expect(textOf(second)).toContain('workspace-write')
    expect(textOf(second)).not.toContain('leaked')
    expect(asked).toEqual([])

    const third = valueOf(
      await Effect.runPromise(call(tool, { command: 'echo "$MARKER"', session: 'work' })),
    )
    expect(third.stdout.trim()).toBe('kept')
    sessions.closeAll()
  })

  test('a session refuses a different directory instead of running in the one it started', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jzh-bash-session-'))
    const sub = join(root, 'sub')
    mkdirSync(sub)
    const sessions = makeShellSessions()
    const tool = makeBashTool(undefined, undefined, undefined, undefined, sessions)
    const first = valueOf(
      await Effect.runPromise(
        call(tool, { command: 'MARKER=kept; echo started', session: 'work', cwd: 'sub' }, root),
      ),
    )
    expect(first.stdout).toContain('started')

    const second = await Effect.runPromise(
      call(tool, { command: 'echo leaked; MARKER=wiped', session: 'work' }, root),
    )

    expect(second?.isError).toBe(true)
    expect(textOf(second)).toContain(sub)
    expect(textOf(second)).not.toContain('leaked')

    const third = valueOf(
      await Effect.runPromise(
        call(tool, { command: 'echo "$MARKER"', session: 'work', cwd: 'sub' }, root),
      ),
    )
    expect(third.stdout.trim()).toBe('kept')
    sessions.closeAll()
  })

  test('a session refuses a different shell instead of running the command in the one it started', async () => {
    const sessions = makeShellSessions()
    const tool = makeBashTool(undefined, undefined, undefined, () => true, sessions)
    const first = valueOf(
      await Effect.runPromise(
        call(tool, { command: 'MARKER=kept; echo started', session: 'work' }),
      ),
    )
    expect(first.stdout).toContain('started')

    const second = await Effect.runPromise(
      call(tool, { command: 'echo leaked; MARKER=wiped', session: 'work', shell: 'powershell' }),
    )

    expect(second?.isError).toBe(true)
    expect(textOf(second)).toContain('bash')
    expect(textOf(second)).not.toContain('leaked')

    const third = valueOf(
      await Effect.runPromise(call(tool, { command: 'echo "$MARKER"', session: 'work' })),
    )
    expect(third.stdout.trim()).toBe('kept')
    sessions.closeAll()
  })

  test('a session call applies its env and lets the managed value win', async () => {
    const sessions = makeShellSessions()
    const tool = makeBashTool(undefined, undefined, undefined, undefined, sessions, {
      JZH_MODE: 'managed',
    })
    const result = valueOf(
      await Effect.runPromise(
        call(tool, {
          command: 'printf %s "$JZH_MODE"',
          session: 'env',
          env: { JZH_MODE: 'caller' },
        }),
      ),
    )

    expect(result.stdout).toBe('managed')
    sessions.closeAll()
  })
})
