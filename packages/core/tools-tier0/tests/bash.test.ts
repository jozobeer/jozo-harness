import { HooksLive } from '@jozo-harness/kernel'
import { type Child } from '@jozo-harness/process'
import type { SandboxShape } from '@jozo-harness/safety'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import { BASH_MAX_TIMEOUT_MS, clampTimeout, makeBashTool, shellArgv } from '../src/index.ts'

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

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

describe('bash tool', () => {
  test('runs a command and returns its output', async () => {
    const result = await Effect.runPromise(call(makeBashTool(), { command: 'echo hi' }, '/tmp'))

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      timedOut: false,
    })
    expect(textOf(result)).toBe('hi\n')
  })

  test('runs the command in a non-login shell', async () => {
    let seen: ReadonlyArray<string> = []
    const wrapping: SandboxShape = {
      name: 'test',
      confines: true,
      mode: 'workspace-write',
      wrap: (command) => {
        seen = command.argv
        return Effect.succeed({
          argv: ['bash', '-c', 'echo wrapped'],
          cwd: command.cwd,
          mode: command.mode ?? 'workspace-write',
          denialSignatures: [],
        })
      },
    }

    const result = await Effect.runPromise(
      call(makeBashTool(wrapping), { command: 'echo raw' }, '/tmp'),
    )

    // A login shell reads ~/.profile, which is outside what the workspace holds.
    expect(seen).toEqual(['bash', '-c', 'echo raw'])
    expect(result?.value).toMatchObject({ exitCode: 0, stdout: 'wrapped\n' })
  })

  test('runs the command the sandbox wrapped', async () => {
    const wrapping: SandboxShape = {
      name: 'test',
      confines: true,
      mode: 'workspace-write',
      wrap: (command) =>
        Effect.succeed({
          argv: ['bash', '-lc', 'echo wrapped'],
          cwd: command.cwd,
          mode: command.mode ?? 'workspace-write',
          denialSignatures: [],
        }),
    }

    const result = await Effect.runPromise(
      call(makeBashTool(wrapping), { command: 'echo raw' }, '/tmp'),
    )

    expect(result?.value).toMatchObject({ exitCode: 0, stdout: 'wrapped\n' })
  })

  test('a failing command is reported with its exit code, not thrown away', async () => {
    const result = await Effect.runPromise(
      call(makeBashTool(), { command: 'echo bad; exit 3' }, '/tmp'),
    )

    expect(result?.isError).toBe(false)
    expect(textOf(result)).toBe('bad\n[exit code: 3]')
    await Promise.resolve()
  })

  test('stderr is marked as its own section', async () => {
    const result = await Effect.runPromise(
      call(makeBashTool(), { command: 'echo out; echo err >&2' }, '/tmp'),
    )

    expect(textOf(result)).toBe('out\n[stderr]\nerr\n')
  })

  test('a silent command still says something', async () => {
    const result = await Effect.runPromise(call(makeBashTool(), { command: 'true' }, '/tmp'))

    expect(textOf(result)).toBe('(no output)')
  })

  test('a command that outlives its timeout is killed and says so', async () => {
    const started = Date.now()

    const result = await Effect.runPromise(
      call(makeBashTool(), { command: 'sleep 30', timeoutMs: 300 }, '/tmp'),
    )
    const elapsed = Date.now() - started

    expect(result?.isError).toBe(false)
    expect(textOf(result)).toContain('[timed out after 300ms]')
    expect(elapsed).toBeLessThan(10_000)
  })

  test('a timed-out command is handed to the job registry instead of killed', async () => {
    const promoted: Array<{ command: string; child: Child }> = []
    const jobs = {
      promote: (command: string, child: Child) =>
        Effect.sync(() => {
          promoted.push({ command, child })
          return { id: 'job-1' }
        }),
    }

    const result = await Effect.runPromise(
      call(
        makeBashTool(undefined, undefined, jobs),
        { command: 'sleep 30', timeoutMs: 300 },
        '/tmp',
      ),
    )

    expect(result?.isError).toBe(false)
    expect(textOf(result)).toContain('[timed out after 300ms; still running as job job-1]')
    expect(promoted).toHaveLength(1)
    expect(promoted[0]?.command).toBe('sleep 30')
    const child = promoted[0]?.child
    const alive = await Promise.race([
      child?.exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
    ])
    expect(alive).toBe(true)
    child?.kill()
  })

  test('the timeout is clamped to what the tool allows', () => {
    expect(clampTimeout(undefined)).toBe(120_000)
    expect(clampTimeout(500)).toBe(500)
    expect(clampTimeout(10_000_000)).toBe(BASH_MAX_TIMEOUT_MS)
    expect(clampTimeout(0)).toBe(1)
  })
})

/** A sandbox that records what it was asked to run and answers with a fixed command. */
const recordingSandbox = (seen: { argv: ReadonlyArray<string> }): SandboxShape => ({
  name: 'test',
  confines: true,
  mode: 'workspace-write',
  wrap: (command) => {
    seen.argv = command.argv
    return Effect.succeed({
      argv: ['bash', '-c', 'echo wrapped'],
      cwd: command.cwd,
      mode: command.mode ?? 'workspace-write',
      denialSignatures: [],
    })
  },
})

describe('shell selection', () => {
  test('builds the argv of each shell from one script', () => {
    expect(shellArgv('bash', 'echo hi')).toEqual(['bash', '-c', 'echo hi'])
    expect(shellArgv('powershell', 'Get-Date')).toEqual([
      'pwsh',
      '-NoProfile',
      '-Command',
      'Get-Date',
    ])
  })

  test('runs PowerShell inside the sandbox the caller chose', async () => {
    const seen: { argv: ReadonlyArray<string> } = { argv: [] }

    const result = await Effect.runPromise(
      call(
        makeBashTool(recordingSandbox(seen), undefined, undefined, () => true),
        { command: 'Get-Date', shell: 'powershell' },
        '/tmp',
      ),
    )

    // The sandbox wraps the shell it is given, so PowerShell is confined the same way as bash.
    expect(seen.argv).toEqual(['pwsh', '-NoProfile', '-Command', 'Get-Date'])
    expect(result?.value).toMatchObject({ exitCode: 0, stdout: 'wrapped\n' })
  })

  test('a machine without pwsh fails the call with a reason instead of running a shell', async () => {
    const seen: { argv: ReadonlyArray<string> } = { argv: [] }

    const result = await Effect.runPromise(
      call(
        makeBashTool(recordingSandbox(seen), undefined, undefined, () => false),
        { command: 'Get-Date', shell: 'powershell' },
        '/tmp',
      ),
    )

    expect(result?.isError).toBe(true)
    expect(result?.error).toEqual({ name: 'ToolError', code: 'execution' })
    expect(textOf(result)).toContain('pwsh')
    expect(seen.argv).toEqual([])
  })
})

describe('managed environment', () => {
  test('a registered variable reaches the command the tool runs', async () => {
    const result = await Effect.runPromise(
      call(
        makeBashTool(undefined, undefined, undefined, undefined, undefined, {
          JZH_WORKSPACE: 'managed-workspace',
        }),
        { command: 'printf %s "$JZH_WORKSPACE"' },
        '/tmp',
      ),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({ exitCode: 0, stdout: 'managed-workspace' })
  })

  test('a managed variable wins over the one the call passes', async () => {
    const result = await Effect.runPromise(
      call(
        makeBashTool(undefined, undefined, undefined, undefined, undefined, {
          JZH_MODE: 'managed',
        }),
        { command: 'printf %s "$JZH_MODE"', env: { JZH_MODE: 'caller' } },
        '/tmp',
      ),
    )

    expect(result?.value).toMatchObject({ stdout: 'managed' })
  })

  test('the log names the managed variables without their values', async () => {
    const writes: Array<string> = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    try {
      await Effect.runPromise(
        call(
          makeBashTool(undefined, undefined, undefined, undefined, undefined, {
            JZH_TOKEN: 's3cret-value',
          }),
          { command: 'true' },
          '/tmp',
        ),
      )
    } finally {
      spy.mockRestore()
    }

    const log = writes.join('')
    expect(log).toContain('JZH_TOKEN')
    expect(log).not.toContain('s3cret-value')
  })

  test('refuses a call env name a shell cannot carry', async () => {
    const result = await Effect.runPromise(
      call(makeBashTool(), { command: 'true', env: { 'BAD NAME': 'x' } }, '/tmp'),
    )

    expect(result?.isError).toBe(true)
    expect(result?.error).toEqual({ name: 'ToolError', code: 'invalid-arguments' })
  })
})
