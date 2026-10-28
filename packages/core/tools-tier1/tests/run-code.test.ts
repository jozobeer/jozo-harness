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
import {
  childArgv,
  makeRunCodeTool,
  RUN_CODE_OUTPUT_LIMIT,
  type RunCodeHost,
  type RunCodeTool,
} from '../src/run-code.ts'

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

const runWith = (tool: RunCodeTool, args: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
        const tools = Context.get(services, Tools)
        yield* tools.register(tool)
        return yield* tools.call({
          callId: context.callId,
          tool: tool.name,
          arguments: JSON.stringify(args),
          context,
        })
      }),
    ).pipe(Effect.ensuring(Effect.suspend(() => tool.closeSessions()))),
  )

const run = (tool: RunCodeTool, code: string) => runWith(tool, { code })

/** Runs several calls through one tool, so the child between them is the session's. */
const runCalls = (
  tool: RunCodeTool,
  calls: ReadonlyArray<{ readonly args: Record<string, unknown>; readonly sessionId?: string }>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
        const tools = Context.get(services, Tools)
        yield* tools.register(tool)
        const results: Array<ToolExecutionResult> = []
        for (const call of calls) {
          const each = {
            ...context,
            ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
          }
          results.push(
            yield* tools.call({
              callId: each.callId,
              tool: tool.name,
              arguments: JSON.stringify(call.args),
              context: each,
            }),
          )
        }
        return results
      }),
    ).pipe(Effect.ensuring(Effect.suspend(() => tool.closeSessions()))),
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

  test('a nested tool that adds context carries it to the outer result in call order', async () => {
    const notes: ReadonlyArray<ReadonlyArray<string>> = [['first note'], ['second note']]
    let calls = 0
    const tool = makeRunCodeTool(
      host(() => {
        const note = notes[calls] ?? []
        calls += 1
        return Effect.succeed({ ...ok('done', {}), context: note })
      }),
    )

    const outcome = await run(
      tool,
      "await tools.echo({ text: 'one' })\nawait tools.echo({ text: 'two' })\nreturn 'done'",
    )

    expect(outcome.context).toEqual(['first note', 'second note'])
  })

  test('a page a nested tool published stays in the outer result', async () => {
    const page: ToolDefinition<{ readonly name: string }, { readonly url: string }> = {
      name: 'artifact',
      description: 'Publish a page',
      parameters: Schema.Struct({ name: Schema.String }),
      output: {
        schema: Schema.Struct({ url: Schema.String }),
        render: (_args, value) => [{ type: 'text', text: 'page: ' + value.url }],
      },
      execute: (args) => Effect.succeed({ url: '/artifact/s-1/' + args.name }),
    }
    const tool = makeRunCodeTool(
      host(
        () =>
          Effect.succeed({
            ...ok('page: /artifact/s-1/report', { url: '/artifact/s-1/report' }),
            context: ['/artifact/s-1/report'],
          }),
        undefined,
        [page],
      ),
    )

    const outcome = await run(tool, "await tools.artifact({ name: 'report' })\nreturn 'published'")

    expect(outcome.isError).toBe(false)
    expect(outcome.context).toEqual(['/artifact/s-1/report'])
    // The child's result is summarized away, so the page line must survive here.
    expect(textOf(outcome.content)).toContain('page: /artifact/s-1/report')
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
    const tool: RunCodeTool = {
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

  test('runs a python program when the runtime asks for it', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {}))))

    const outcome = await runWith(tool, {
      runtime: 'python',
      code: 'print("hi from python")',
    })

    expect(outcome.isError).toBe(false)
    expect(textOf(outcome.content)).toContain('hi from python')
    expect(outcome.value).toMatchObject({ toolCalls: 0 })
  })

  test('a python program calls a tool and reads the value it returns', async () => {
    const seen: Array<{ name: string; args: string; callId: string }> = []
    const tool = makeRunCodeTool(
      host((name, args, nested) => {
        seen.push({ name, args, callId: nested.callId })
        return Effect.succeed(ok('hi', { text: 'hi' }))
      }),
    )

    const outcome = await runWith(tool, {
      runtime: 'python',
      code: "result = tools.echo(text='hi')\nprint('got ' + result['text'])",
    })

    expect(outcome.isError).toBe(false)
    expect(seen).toEqual([{ name: 'echo', args: '{"text":"hi"}', callId: 'call-1.1' }])
    expect(outcome.value).toMatchObject({ toolCalls: 1 })
    expect(textOf(outcome.content)).toContain('got hi')
  })

  test('a failed python tool call raises inside the program', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(failed('denied: no'))))

    const outcome = await runWith(tool, {
      runtime: 'python',
      code:
        'try:\n' +
        "    tools.echo(text='x')\n" +
        'except RuntimeError as error:\n' +
        "    print('caught ' + str(error))",
    })

    expect(outcome.isError).toBe(false)
    expect(textOf(outcome.content)).toContain('caught denied: no')
  })

  test('a python program records its nested calls in the log under the parent call id', async () => {
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
        () => Effect.succeed(ok('first', {})),
        undefined,
        [echo],
        (type, data) => session.append(type, data),
      ),
    )

    const outcome = await runWith(tool, { runtime: 'python', code: "tools.echo(text='one')" })

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
    ])
  })

  test('the python runtime runs python3, and node stays the default', () => {
    expect(childArgv('python')).toEqual(['python3', '-c', expect.any(String)])
    expect(childArgv('node')[0]).toBe(process.execPath)
    expect(childArgv('node')[1]).toBe('-e')
  })

  test('the next call in the same session sees what the previous program put on globalThis', async () => {
    const outcomes = await runCalls(makeRunCodeTool(host(() => Effect.succeed(ok('unused', {})))), [
      { args: { code: 'globalThis.total = 41' } },
      { args: { code: 'globalThis.total += 1\nreturn globalThis.total' } },
    ])

    expect(outcomes[0]?.isError).toBe(false)
    expect(outcomes[1]?.isError).toBe(false)
    expect(textOf(outcomes[1]?.content ?? [])).toContain('return: 42')
  })

  test('a program in another session does not see the values of the first', async () => {
    const outcomes = await runCalls(makeRunCodeTool(host(() => Effect.succeed(ok('unused', {})))), [
      { args: { code: 'globalThis.total = 41' } },
      { args: { code: 'return typeof globalThis.total' }, sessionId: 's-2' },
    ])

    expect(textOf(outcomes[1]?.content ?? [])).toContain('return: "undefined"')
  })

  test('closing the session children forgets what the programs created', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {}))))
    try {
      await Effect.runPromise(tool.execute({ code: 'globalThis.total = 41' }, context))
      await Effect.runPromise(tool.closeSessions())
      const next = await Effect.runPromise(
        tool.execute({ code: 'return typeof globalThis.total' }, context),
      )

      expect(next.output).toContain('return: "undefined"')
    } finally {
      await Effect.runPromise(tool.closeSessions())
    }
  })

  test('a timed-out program takes its child with it, so the next call starts fresh', async () => {
    const tool: RunCodeTool = {
      ...makeRunCodeTool(host(() => Effect.succeed(ok('unused', {})))),
      timeoutMs: 150,
    }

    const outcomes = await runCalls(tool, [
      {
        args: {
          code: 'globalThis.hung = true\nawait new Promise((resolve) => setTimeout(resolve, 5000))',
        },
      },
      { args: { code: 'return typeof globalThis.hung' } },
    ])

    expect(outcomes[0]?.isError).toBe(true)
    expect(textOf(outcomes[0]?.content ?? [])).toContain('timed out after')
    expect(textOf(outcomes[1]?.content ?? [])).toContain('return: "undefined"')
  })

  test('runs TypeScript after removing its annotations, as, and satisfies', async () => {
    const tool = makeRunCodeTool(host(() => Effect.succeed(ok('unused', {}))))

    const outcome = await run(
      tool,
      [
        'interface Point { readonly x: number }',
        'const declared: Point = { x: 3 }',
        "const key = 'x' as keyof Point",
        'return (declared satisfies Point)[key]',
      ].join('\n'),
    )

    expect(outcome.isError).toBe(false)
    expect(textOf(outcome.content)).toContain('return: 3')
  })

  test('a program whose types cannot be removed is refused before a child starts', async () => {
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

    const outcome = await run(tool, 'enum Colour { Red }\nreturn Colour.Red')

    expect(outcome.isError).toBe(true)
    expect(textOf(outcome.content)).toContain('could not remove the type annotations')
    expect(textOf(outcome.content)).toContain('enum')
    expect(seen).toHaveLength(0)
  })

  test('a python program sees the names the previous one bound', async () => {
    const outcomes = await runCalls(makeRunCodeTool(host(() => Effect.succeed(ok('unused', {})))), [
      { args: { runtime: 'python', code: 'total = 41' } },
      { args: { runtime: 'python', code: 'print(total + 1)' } },
    ])

    expect(outcomes[0]?.isError).toBe(false)
    expect(outcomes[1]?.isError).toBe(false)
    expect(textOf(outcomes[1]?.content ?? [])).toContain('42')
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
