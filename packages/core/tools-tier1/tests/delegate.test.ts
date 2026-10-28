import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import { makeHooks } from '@jozo-harness/kernel'
import { makeTools, type ToolDefinition, type ToolError } from '@jozo-harness/tools'
import { DelegateTools, delegatePlugin } from '../src/delegate.ts'
import {
  MAX_DELEGATE_OUTPUT,
  MAX_DELEGATE_STDERR,
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

/** Runs the tool through the real registry, where a failure must settle as a result. */
const callThroughPipeline = (
  tool: ToolDefinition<any, any>,
  args: { command: string; task: string } = { command: 'codex', task: 't' },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tools = makeTools(makeHooks())
        yield* tools.register(tool)
        return yield* tools.call({
          callId: 'c1',
          tool: tool.name,
          arguments: JSON.stringify(args),
          context: { sessionId: 's1', cwd: '/work', callId: 'c1' },
        })
      }),
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
    expect(value).toEqual({
      command: 'codex',
      text: 'done\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
      stderrTruncated: false,
    })
  })

  test('takes the run working directory when cwd is left out, as subagent does', async () => {
    const seen: { cwd?: string } = {}
    const host = hostOf(['codex'], async (command) => {
      seen.cwd = command.cwd
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    })

    const { error } = await delegate({ command: 'codex', task: 't' }, host)

    expect(error).toBeUndefined()
    expect(seen.cwd).toBe('/work')
  })

  test('keeps both streams and the exit code so the parent log shows what the child did', async () => {
    const host = hostOf(['codex'], async () => ({
      exitCode: 0,
      stdout: 'the answer\n',
      stderr: 'warning: cache cold\n',
    }))

    const { value } = await delegate({ command: 'codex', task: 't' }, host)

    expect(value?.text).toBe('the answer\n')
    expect(value?.stderr).toBe('warning: cache cold\n')
    expect(value?.exitCode).toBe(0)
  })

  test('cuts stderr at its own cap and marks it', async () => {
    const long = 'e'.repeat(MAX_DELEGATE_STDERR + 1)
    const host = hostOf(['codex'], async () => ({ exitCode: 0, stdout: '', stderr: long }))

    const { value } = await delegate({ command: 'codex', task: 't' }, host)

    expect(value?.stderr.length).toBe(MAX_DELEGATE_STDERR)
    expect(value?.stderrTruncated).toBe(true)
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

  test('reports a signal death as a failed call and keeps what the child wrote', async () => {
    const host = hostOf(['codex'], async () => ({
      // The process package reports a signal as 128 + the signal number.
      exitCode: 137,
      stdout: 'half an answer',
      stderr: 'killed while working',
    }))

    const { error } = await delegate({ command: 'codex', task: 't' }, host)

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('exit 137')
    expect(error?.message).toContain('killed while working')
    expect(error?.message).toContain('half an answer')
  })

  test('a CLI that cannot start settles as one failed result that names the reason', async () => {
    const host = hostOf(['codex'], async () => {
      throw new Error('spawn EACCES')
    })

    const outcome = await callThroughPipeline(makeDelegateTool(allowed, noneSandbox, host))

    expect(outcome.isError).toBe(true)
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'unavailable' })
    expect(JSON.stringify(outcome.content)).toContain('spawn EACCES')
  })

  test('keeps the task in the call and both streams in the result the parent logs', async () => {
    const seen: string[] = []
    const host = hostOf(['codex'], async (command) => {
      seen.push(command.argv[command.argv.length - 1] ?? '')
      return { exitCode: 0, stdout: 'the answer', stderr: 'a warning' }
    })
    const tool = makeDelegateTool(allowed, noneSandbox, host)

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = makeTools(makeHooks())
          yield* tools.register(tool)
          const argumentsJson = JSON.stringify({ command: 'codex', task: 'fix the failing test' })
          const callView = tools.presentCall('delegate', argumentsJson)
          const result = yield* tools.call({
            callId: 'c1',
            tool: 'delegate',
            arguments: argumentsJson,
            context: { sessionId: 's1', cwd: '/work', callId: 'c1' },
          })
          return { argumentsJson, callView, result }
        }),
      ),
    )

    expect(seen).toEqual(['fix the failing test'])
    expect(outcome.argumentsJson).toContain('fix the failing test')
    expect(outcome.callView.summary).toContain('fix the failing test')
    expect(JSON.stringify(outcome.result.content)).toContain('the answer')
    expect(JSON.stringify(outcome.result.content)).toContain('a warning')
  })

  test('a stuck CLI times out as one failed call, not a failed turn', async () => {
    const host = hostOf(['codex'], () => new Promise(() => {}))
    const tool = makeDelegateTool(allowed, noneSandbox, host, 10)

    const outcome = await callThroughPipeline(tool)

    expect(outcome.isError).toBe(true)
    expect(outcome.error).toEqual({ name: 'TimeoutError', code: 'timeout' })
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
        {
          command: 'codex',
          text: 'hi',
          stderr: '',
          exitCode: 0,
          truncated: false,
          stderrTruncated: false,
        },
      ),
    ).toEqual([{ type: 'text', text: 'hi' }])
  })

  test('renders a clean exit with stderr beside the answer', () => {
    const tool = makeDelegateTool(allowed, noneSandbox, hostOf(['codex']))

    expect(
      tool.output.render(
        { command: 'codex', task: 't' },
        {
          command: 'codex',
          text: 'hi',
          stderr: 'warn',
          exitCode: 0,
          truncated: false,
          stderrTruncated: false,
        },
      ),
    ).toEqual([{ type: 'text', text: 'hi\n\n[stderr]\nwarn' }])
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

    expect(tool.presentCall?.(args)).toMatchObject({ summary: 'delegate to codex: t' })
    expect(tool.presentResult?.(args, { isError: false, summary: '' })).toMatchObject({
      summary: 'delegated to codex',
    })
    expect(tool.isConcurrencySafe?.(args)).toBe(true)
  })
})
