import { HooksLive } from '@jozo-harness/kernel'
import type { ContentBlock } from '@jozo-harness/llm'
import { makeAsk, type SandboxShape } from '@jozo-harness/safety'
import {
  decodeSessionEvent,
  makeSession,
  type SessionEvent,
  type SessionSink,
} from '@jozo-harness/session'
import {
  Tools,
  toolDeclaration,
  toolsLayer,
  type ToolDefinition,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { tier1Tools } from '../src/index.ts'
import { makeRunCodeTool, RUN_CODE_OUTPUT_LIMIT, type RunCodeHost } from '../src/run-code.ts'

const context = { sessionId: 's-1', cwd: process.cwd(), callId: 'call-1' }

const echo: ToolDefinition<{ readonly text: string }, { readonly text: string }> = {
  name: 'echo',
  description: 'Echo text back',
  parameters: Schema.Struct({ text: Schema.String }),
  output: {
    schema: Schema.Struct({ text: Schema.String }),
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  execute: (args) => Effect.succeed({ text: args.text }),
}

const ok = (text: string, value: unknown): ToolExecutionResult => ({
  isError: false,
  content: [{ type: 'text', text }],
  value,
})

const failed = (text: string): ToolExecutionResult => ({
  isError: true,
  content: [{ type: 'text', text }],
})

const textOf = (content: ReadonlyArray<ContentBlock>): string =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

const host = (
  call: RunCodeHost['call'],
  sandbox?: SandboxShape,
  declarations: ReadonlyArray<ToolDefinition<any, any>> = [echo],
  append: RunCodeHost['append'] = () => Effect.void,
): RunCodeHost => ({
  tools: () => declarations.map((tool) => toolDeclaration(tool)),
  call,
  append,
  ...(sandbox === undefined ? {} : { sandbox }),
})

const run = (tool: ToolDefinition<any, any>, code: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
        const tools = Context.get(services, Tools)
        yield* tools.register(tool)
        return yield* tools.call({
          callId: context.callId,
          tool: tool.name,
          arguments: JSON.stringify({ code }),
          context,
        })
      }),
    ),
  )

describe('run_code', () => {
  test('calls a tool from the program and returns its output and value', async () => {
    const seen: Array<{ name: string; args: string; callId: string }> = []
    const tool = makeRunCodeTool(
      host((name, args, nested) => {
        seen.push({ name, args, callId: nested.callId })
        return Effect.succeed(ok('hi', { text: 'hi' }))
      }),
    )

    const outcome = await run(
      tool,
      "const result = await tools.echo({ text: 'hi' })\nconsole.log('got ' + result.text)\nreturn result.text",
    )

    expect(outcome.isError).toBe(false)
    expect(seen).toEqual([{ name: 'echo', args: '{"text":"hi"}', callId: 'call-1.1' }])
    expect(outcome.value).toMatchObject({ toolCalls: 1, truncated: false })
    expect(textOf(outcome.content)).toContain('got hi')
    expect(textOf(outcome.content)).toContain('return: "hi"')
  })

  test('a nested failure reaches the program as a thrown error', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(failed('denied: no'))))

    const outcome = await run(
      tool,
      "try { await tools.echo({ text: 'x' }) } catch (error) { return 'caught ' + error.message }",
    )

    expect(outcome.isError).toBe(false)
    expect(textOf(outcome.content)).toContain('caught denied: no')
  })

  test('records each nested call and its result in the log under the parent call id', async () => {
    const appended: Array<SessionEvent> = []
    const sink: SessionSink = {
      append: (event) =>
        Effect.sync(() => {
          appended.push(event)
        }),
      flush: () => Effect.void,
    }
    const session = await Effect.runPromise(
      makeSession({
        id: 's-1',
        events: [
          {
            seq: 1,
            time: 1,
            type: 'session/header',
            data: { formatVersion: 1, createdAt: 1, cwd: process.cwd() },
          },
        ],
        sink,
        now: () => 50,
      }),
    )
    const tool = makeRunCodeTool(
      host(
        (_name, args) =>
          Effect.succeed(args === '{"text":"one"}' ? ok('first', {}) : failed('second failed')),
        undefined,
        [echo],
        (type, data) => session.append(type, data),
      ),
    )

    const outcome = await run(
      tool,
      "await tools.echo({ text: 'one' })\ntry { await tools.echo({ text: 'two' }) } catch {}\nreturn 'done'",
    )

    expect(outcome.isError).toBe(false)
    expect(appended).toEqual([
      {
        seq: 2,
        time: 50,
        type: 'tool/ptc-dispatch-start',
        data: { callId: 'call-1.1', name: 'echo', arguments: '{"text":"one"}' },
      },
      {
        seq: 3,
        time: 50,
        type: 'tool/ptc-dispatch',
        data: {
          callId: 'call-1.1',
          name: 'echo',
          arguments: '{"text":"one"}',
          isError: false,
          summary: 'first',
        },
      },
      {
        seq: 4,
        time: 50,
        type: 'tool/ptc-dispatch-start',
        data: { callId: 'call-1.2', name: 'echo', arguments: '{"text":"two"}' },
      },
      {
        seq: 5,
        time: 50,
        type: 'tool/ptc-dispatch',
        data: {
          callId: 'call-1.2',
          name: 'echo',
          arguments: '{"text":"two"}',
          isError: true,
          summary: 'second failed',
        },
      },
    ])
    // Nested calls are log-only: a reader decodes them, and the model history stays put.
    const decoded = await Effect.runPromise(
      Effect.forEach(appended, (event) => decodeSessionEvent(event)),
    )
    expect(decoded.map((event) => event?.type)).toEqual([
      'tool/ptc-dispatch-start',
      'tool/ptc-dispatch',
      'tool/ptc-dispatch-start',
      'tool/ptc-dispatch',
    ])
    expect(session.derive()).toEqual([])
  })

  test('a program that throws ends as an error result', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {}))))

    const outcome = await run(tool, "throw new Error('boom')")

    expect(outcome.isError).toBe(true)
    expect(textOf(outcome.content)).toContain('boom')
  })

  test('stdout without a newline stays output beside the record', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {}))))

    const outcome = await run(tool, "process.stdout.write('raw')\nreturn 1")

    expect(outcome.isError).toBe(false)
    expect(textOf(outcome.content)).toContain('raw')
    expect(textOf(outcome.content)).toContain('return: 1')
    expect(textOf(outcome.content)).not.toContain('"t":"final"')
  })

  test('a child that dies before its final message ends as an error result', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {}))))

    const outcome = await run(tool, 'process.exit(3)')

    expect(outcome.isError).toBe(true)
    expect(textOf(outcome.content)).toContain('run_code exited with code 3')
  })

  test('output past the limit is cut and marked', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {}))))

    const outcome = await run(
      tool,
      "console.log('x'.repeat(" + String(RUN_CODE_OUTPUT_LIMIT + 500) + '))',
    )

    expect(outcome.isError).toBe(false)
    expect(outcome.value).toMatchObject({ truncated: true })
    expect(textOf(outcome.content)).toContain('output truncated after')
  })

  test('a program still running at the timeout is ended', async () => {
    const tool: ToolDefinition<any, any> = {
      ...makeRunCodeTool(host(() => Effect.succeed(ok('unused', {})))),
      timeoutMs: 100,
    }

    const outcome = await run(tool, 'await new Promise((resolve) => setTimeout(resolve, 5000))')

    expect(outcome.isError).toBe(true)
    expect(textOf(outcome.content)).toContain('timed out after')
  })

  test('the sandbox wraps the child command', async () => {
    const seen: Array<ReadonlyArray<string>> = []
    const sandbox: SandboxShape = {
      name: 'probe',
      confines: false,
      mode: 'workspace-write',
      wrap: (command) => {
        seen.push(command.argv)
        return Effect.succeed({
          argv: command.argv,
          cwd: command.cwd,
          mode: 'workspace-write',
          denialSignatures: [],
        })
      },
    }
    const tool = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {})), sandbox))

    const outcome = await run(tool, 'return 7')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.[0]).toBe(process.execPath)
    expect(textOf(outcome.content)).toContain('return: 7')
  })

  test('run_code is not offered to the program itself', async () => {
    const self = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {}))))
    const tool = makeRunCodeTool(
      host(() => Effect.succeed(ok('unused', {})), undefined, [echo, self]),
    )

    const outcome = await run(tool, 'return typeof tools.run_code')

    expect(textOf(outcome.content)).toContain('return: "undefined"')
  })

  test('tier 1 lists run_code only when it was given a host', async () => {
    const ask = await Effect.runPromise(makeAsk())

    expect(tier1Tools(ask).map((tool) => tool.name)).not.toContain('run_code')
    expect(
      tier1Tools(
        ask,
        [],
        host(() => Effect.succeed(ok('unused', {}))),
      ).map((tool) => tool.name),
    ).toContain('run_code')
  })
})
