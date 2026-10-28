import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import type { ToolError } from '@jozo-harness/tools'
import { DelegateTools, delegatePlugin } from '../src/delegate.ts'
import {
  MAX_DELEGATE_OUTPUT,
  delegateArgv,
  makeDelegateTool,
  systemDelegateHost,
  type DelegateHost,
  type DelegateValue,
  type ExternalAgent,
} from '../src/index.ts'

const codex: ExternalAgent = { name: 'codex', argv: ['codex', 'exec', '--full-auto'] }
const allowed: ReadonlyArray<ExternalAgent> = [codex]

const hostOf = (
  programs: ReadonlyArray<string>,
  run: DelegateHost['run'] = async () => ({ exitCode: 0, stdout: '', stderr: '' }),
): DelegateHost => ({
  hasProgram: (program) => programs.includes(program),
  run,
})

interface DelegateOutcome {
  readonly value: DelegateValue | undefined
  readonly error: ToolError | undefined
}

const delegate = (
  args: { command: string; task: string; cwd?: string },
  host: DelegateHost,
  agents: ReadonlyArray<ExternalAgent> = allowed,
  sandbox: SandboxShape = noneSandbox,
): Promise<DelegateOutcome> =>
  Effect.runPromise(
    Effect.match(
      makeDelegateTool(agents, sandbox, host).execute(args, {
        sessionId: 's1',
        cwd: '/work',
        callId: 'c1',
      }),
      {
        onFailure: (error) => ({ value: undefined, error }),
        onSuccess: (value) => ({ value, error: undefined }),
      },
    ),
  )

describe('delegateArgv', () => {
  test('appends the task to the argv the config allows', () => {
    expect(delegateArgv(allowed, 'codex', 'summarize the repo')).toEqual([
      'codex',
      'exec',
      '--full-auto',
      'summarize the repo',
    ])
  })

  test('has no argv for a command the config does not allow', () => {
    expect(delegateArgv(allowed, 'claude', 'summarize the repo')).toBeUndefined()
  })
})

describe('delegate tool', () => {
  test('refuses a command the config does not allow, without running anything', async () => {
    let ran = 0
    const host = hostOf(['codex', 'claude'], async () => {
      ran += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    const { value, error } = await delegate({ command: 'claude', task: 'review this' }, host)

    expect(error?.code).toBe('invalid-arguments')
    expect(error?.message).toContain('codex')
    expect(value).toBeUndefined()
    expect(ran).toBe(0)
  })

  test('says which command it looked for where the CLI is not installed', async () => {
    let ran = 0
    const host = hostOf([], async () => {
      ran += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    const { error } = await delegate({ command: 'codex', task: 'review this' }, host)

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('codex')
    expect(ran).toBe(0)
  })

  test('wraps the configured argv with the run sandbox and returns the output', async () => {
    const seen: { argv?: ReadonlyArray<string>; cwd?: string } = {}
    const sandbox: SandboxShape = {
      ...noneSandbox,
      name: 'recording',
      confines: true,
      mode: 'workspace-write',
      wrap: (command) =>
        Effect.sync(() => {
          seen.argv = command.argv
          seen.cwd = command.cwd
          return {
            argv: command.argv,
            cwd: command.cwd,
            mode: 'workspace-write',
            denialSignatures: [],
          }
        }),
    }
    const host = hostOf(['codex'], async () => ({
      exitCode: 0,
      stdout: 'done\n',
      stderr: '',
    }))

    const { value, error } = await delegate(
      { command: 'codex', task: 'summarize', cwd: '/elsewhere' },
      host,
      allowed,
      sandbox,
    )

    expect(error).toBeUndefined()
    expect(seen.argv).toEqual(['codex', 'exec', '--full-auto', 'summarize'])
    expect(seen.cwd).toBe('/elsewhere')
    expect(value).toEqual({ command: 'codex', text: 'done\n', truncated: false })
  })

  test('keeps the output under the cap and marks where it cut', async () => {
    const long = 'a'.repeat(MAX_DELEGATE_OUTPUT + 1)
    const host = hostOf(['codex'], async () => ({ exitCode: 0, stdout: long, stderr: '' }))

    const { value } = await delegate({ command: 'codex', task: 'dump' }, host)

    expect(value?.text.length).toBe(MAX_DELEGATE_OUTPUT)
    expect(value?.truncated).toBe(true)
  })

  test('fails the call when the agent exits non-zero, naming the code and what it said', async () => {
    const host = hostOf(['codex'], async () => ({
      exitCode: 2,
      stdout: '',
      stderr: 'boom\n',
    }))

    const { error } = await delegate({ command: 'codex', task: 't' }, host)

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('exit 2')
    expect(error?.message).toContain('boom')
  })

  test('reports a host that cannot start the program, rather than failing the turn', async () => {
    const host = hostOf(['codex'], async () => {
      throw new Error('spawn EACCES')
    })

    const { error } = await delegate({ command: 'codex', task: 't' }, host)

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('spawn EACCES')
  })

  test('renders the output as one text block', () => {
    const tool = makeDelegateTool(allowed, noneSandbox, hostOf(['codex']))

    expect(
      tool.output.render(
        { command: 'codex', task: 't' },
        { command: 'codex', text: 'hi', truncated: false },
      ),
    ).toEqual([{ type: 'text', text: 'hi' }])
  })

  test('the plugin hands the tool to whatever sandbox the run has', () => {
    const built = Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(delegatePlugin.layer({ tools: allowed }))
          return Context.get(services, DelegateTools)
        }),
      ),
    )

    expect(built(noneSandbox).map((tool) => tool.name)).toEqual(['delegate'])
  })

  test('the system host finds a program on PATH and runs it', async () => {
    expect(systemDelegateHost.hasProgram('sh')).toBe(true)
    expect(systemDelegateHost.hasProgram('not-a-program-anywhere-xyz')).toBe(false)
    const ran = await systemDelegateHost.run({ argv: ['sh', '-c', 'echo hi'], cwd: '.' })
    expect(ran.stdout.trim()).toBe('hi')
  })

  test('names the agent in the call and the result, and may run beside another call', () => {
    const tool = makeDelegateTool(allowed, noneSandbox, hostOf(['codex']))
    const args = { command: 'codex', task: 't' }

    expect(tool.presentCall?.(args)).toMatchObject({ summary: 'delegate to codex' })
    expect(tool.presentResult?.(args, { isError: false, summary: '' })).toMatchObject({
      summary: 'delegated to codex',
    })
    expect(tool.isConcurrencySafe?.(args)).toBe(true)
  })
})
