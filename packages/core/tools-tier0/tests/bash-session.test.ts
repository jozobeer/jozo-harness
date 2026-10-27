import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { realpathSync } from 'node:fs'
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
})
