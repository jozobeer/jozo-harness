import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import type { ToolError } from '@jozo-harness/tools'
import {
  MAX_DELEGATE_OUTPUT,
  delegateArgv,
  makeDelegateTool,
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
})
