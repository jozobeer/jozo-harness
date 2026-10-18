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
import { describe, expect, test } from 'vitest'
import { BASH_MAX_TIMEOUT_MS, clampTimeout, makeBashTool } from '../src/index.ts'

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
