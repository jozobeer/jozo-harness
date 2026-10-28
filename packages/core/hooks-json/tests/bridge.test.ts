import { afterEach, describe, expect, test } from 'vitest'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Effect, Layer, Schema, type Scope } from 'effect'
import { Hooks, HooksLive, makeHooks, type HookRegistry } from '@jozo-harness/kernel'
import { Sandbox, noneSandbox } from '@jozo-harness/safety'
import {
  makeTools,
  ToolError,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolRegistry,
} from '@jozo-harness/tools'
import { installHooksJson } from '../src/bridge.ts'
import { hooksJsonPlugin } from '../src/plugin.ts'

const dirs: Array<string> = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'jzh-hooks-json-'))
  dirs.push(dir)
  return dir
}

const toolOf = (
  cwd: string,
): ToolDefinition<{ readonly text: string }, { readonly text: string }> => ({
  name: 'echo',
  description: 'Echo text back',
  parameters: Schema.Struct({ text: Schema.String }),
  output: {
    schema: Schema.Struct({ text: Schema.String }),
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  execute: (args) =>
    Effect.sync(() => {
      appendFileSync(join(cwd, 'calls.log'), 'tool\n')
      return { text: args.text }
    }),
  isConcurrencySafe: () => true,
})

const call = (cwd: string) => ({
  callId: 'call-1',
  tool: 'echo',
  arguments: '{"text":"ok"}',
  context: { sessionId: 's-1', cwd, callId: 'call-1' },
})

interface Harness {
  readonly hooks: HookRegistry
  readonly tools: ToolRegistry
}

const withBridge = async <A>(
  dir: string,
  body: (harness: Harness) => Effect.Effect<A, ToolError, Scope.Scope>,
  timeoutMs = 5000,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hooks = makeHooks()
        const tools = makeTools(hooks)
        yield* installHooksJson(hooks, noneSandbox, { path: 'hooks.json', timeoutMs })
        yield* tools.register(toolOf(dir))
        return yield* body({ hooks, tools })
      }),
    ),
  )

const writeHooks = (dir: string, raw: unknown): Promise<void> =>
  writeFile(join(dir, 'hooks.json'), JSON.stringify(raw))

const logOf = async (dir: string): Promise<string> => readFile(join(dir, 'calls.log'), 'utf8')

describe('foreign hooks at the tool pipeline', () => {
  test('runs a PreToolUse command before the tool body', async () => {
    const dir = await tempDir()
    await writeHooks(dir, {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'echo pre >> "' + dir + '/calls.log"' }] },
        ],
      },
    })

    const outcome = await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    expect(outcome.isError).toBe(false)
    expect(await logOf(dir)).toBe('pre\ntool\n')
  })

  test('runs a PostToolUse command after the tool body', async () => {
    const dir = await tempDir()
    await writeHooks(dir, {
      PostToolUse: [{ hooks: [{ command: 'echo post >> "' + dir + '/calls.log"' }] }],
    })

    await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    expect(await logOf(dir)).toBe('tool\npost\n')
  })

  test('a denying hook stops the body and leaves its reason in the result and the log', async () => {
    const dir = await tempDir()
    await writeHooks(dir, {
      hooks: {
        PreToolUse: [{ matcher: 'Echo', hooks: [{ command: 'echo blocked >&2; exit 2' }] }],
      },
    })
    const results: Array<ToolExecutionResult> = []

    const outcome = await withBridge(dir, ({ hooks, tools }) =>
      Effect.gen(function* () {
        yield* hooks.on('tools/result', (result) => {
          results.push(result)
        })
        return yield* tools.call(call(dir))
      }),
    )

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('blocked')
    expect(outcome.error).toEqual({ name: 'ToolError', code: 'denied', reason: 'blocked' })
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0]?.content)).toContain('blocked')
    await expect(readFile(join(dir, 'calls.log'), 'utf8')).rejects.toThrow()
  })

  test('a JSON decision to deny stops the body too', async () => {
    const dir = await tempDir()
    await writeHooks(dir, {
      PreToolUse: [{ hooks: [{ command: 'echo \'{"decision":"deny","reason":"not allowed"}\'' }] }],
    })

    const outcome = await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('not allowed')
  })

  test('a PostToolUse denial turns the settled result into an error', async () => {
    const dir = await tempDir()
    await writeHooks(dir, {
      PostToolUse: [{ hooks: [{ command: 'echo \'{"decision":"deny","reason":"fix it"}\'' }] }],
    })

    const outcome = await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('fix it')
    expect(await logOf(dir)).toBe('tool\n')
  })

  test('a session without hooks.json keeps the same call and result', async () => {
    const dir = await tempDir()

    const outcome = await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    expect(outcome.isError).toBe(false)
    expect(outcome.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(outcome.context).toBeUndefined()
    expect(await logOf(dir)).toBe('tool\n')
  })

  test('a broken hooks.json passes through and leaves the reason for the model', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'hooks.json'), '{ not json')

    const outcome = await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    expect(outcome.isError).toBe(false)
    expect(JSON.stringify(outcome.content)).toBe('[{"type":"text","text":"ok"}]')
    expect(JSON.stringify(outcome.context)).toContain('not valid JSON')
    expect(await logOf(dir)).toBe('tool\n')
  })

  test('runs a hook only for the tool its matcher names', async () => {
    const dir = await tempDir()
    await writeHooks(dir, {
      PreToolUse: [
        { matcher: 'Read', hooks: [{ command: 'echo pre >> "' + dir + '/calls.log"' }] },
      ],
    })

    await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    expect(await logOf(dir)).toBe('tool\n')
  })

  test('writes the call to the hook on stdin', async () => {
    const dir = await tempDir()
    const payloadPath = join(dir, 'payload.json')
    await writeHooks(dir, {
      PreToolUse: [{ hooks: [{ command: 'cat > "' + payloadPath + '"' }] }],
    })

    await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    const payload = JSON.parse(await readFile(payloadPath, 'utf8')) as Record<string, unknown>
    expect(payload['hook_event_name']).toBe('PreToolUse')
    expect(payload['tool_name']).toBe('echo')
    expect(payload['tool_input']).toEqual({ text: 'ok' })
    expect(payload['session_id']).toBe('s-1')
    expect(payload['cwd']).toBe(dir)
  })

  test('a hook past its own timeout denies without waiting for it', async () => {
    const dir = await tempDir()
    await writeHooks(dir, {
      PreToolUse: [{ hooks: [{ command: 'sleep 5', timeout: 0.05 }] }],
    })

    const outcome = await withBridge(dir, ({ tools }) => tools.call(call(dir)))

    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome.content)).toContain('timed out')
  })
})

describe('plugin layer', () => {
  test('builds the listeners from the profile row', async () => {
    const dir = await tempDir()
    await writeHooks(dir, {
      PreToolUse: [{ hooks: [{ command: 'echo pre >> "' + dir + '/calls.log"' }] }],
    })
    const layer = hooksJsonPlugin.layer({ path: 'hooks.json' })

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            Layer.provideMerge(layer, Layer.merge(HooksLive, Layer.succeed(Sandbox, noneSandbox))),
          )
          const hooks = Context.get(context, Hooks)
          const tools = makeTools(hooks)
          yield* tools.register(toolOf(dir))
          return yield* tools.call(call(dir))
        }),
      ),
    )

    expect(outcome.isError).toBe(false)
    expect(await logOf(dir)).toBe('pre\ntool\n')
  })
})
