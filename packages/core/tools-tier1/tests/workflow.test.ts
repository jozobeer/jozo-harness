import type { Agent, AgentsShape } from '@jozo-harness/agent'
import { HooksLive } from '@jozo-harness/kernel'
import { SandboxError, type SandboxShape } from '@jozo-harness/safety'
import type { SessionEvent } from '@jozo-harness/session'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeSubagentTool, makeWorkflowTool, type WorkflowTask } from '../src/index.ts'

/** What one child is told to answer, by the task it was given. */
type Answers = Readonly<Record<string, string>>

interface FakeAgentsOptions {
  readonly depth?: number
  readonly events?: ReadonlyArray<SessionEvent>
  readonly failCreate?: boolean
  readonly refuseFollowup?: boolean
  readonly failFollowup?: boolean
  readonly failIdle?: boolean
  readonly idle?: Effect.Effect<void>
  readonly childEvents?: ReadonlyArray<SessionEvent>
  readonly created?: Array<{
    readonly cwd: string
    readonly options: { readonly route: string }
    readonly parent: string
  }>
}

const answerEvent = (text: string): SessionEvent =>
  ({
    seq: 1,
    time: 0,
    type: 'assistant/message',
    data: { content: [{ type: 'text', text }] },
  }) as unknown as SessionEvent

const fakeAgents = (
  answers: Answers,
  started: Array<string>,
  options: FakeAgentsOptions = {},
): AgentsShape => {
  let counter = 0
  return {
    create: (args: { cwd: string; options: { route: string }; parent: string }) =>
      options.failCreate === true
        ? Effect.fail(new Error('no child today'))
        : Effect.sync(() => {
            options.created?.push(args)
            counter += 1
            let answer = ''
            let events: Array<SessionEvent> = [answerEvent(answer)]
            const agent = {
              id: 'child-' + String(counter),
              session: { events: () => events },
              // The child answers whatever it is told, once it is told.
              followup: (message: { text: string }) =>
                options.failFollowup === true
                  ? Effect.fail(new Error('the child is gone'))
                  : options.refuseFollowup === true
                    ? Effect.succeed(false)
                    : Effect.sync(() => {
                        started.push(message.text)
                        answer = answers[message.text] ?? ''
                        events = [answerEvent(answer), ...(options.childEvents ?? [])]
                      }),
              whenIdle:
                options.failIdle === true
                  ? Effect.fail(new Error('the child is stuck'))
                  : (options.idle ?? Effect.sleep('2 millis')),
            } as unknown as Agent
            return agent
          }),
    get: (id: string) =>
      id === 's1' ? { session: { events: () => options.events ?? [] } } : undefined,
    depthOf: () => options.depth ?? 0,
  } as unknown as AgentsShape
}

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
  cwd: string = process.cwd(),
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

/** The failure reason a script answer carries, so a test never reads through an optional value. */
const reasonOf = (result: ToolExecutionResult | undefined): string => {
  const value = result?.value
  if (typeof value !== 'object' || value === null || !('reason' in value)) return ''
  return typeof value.reason === 'string' ? value.reason : ''
}

const tasks: ReadonlyArray<WorkflowTask> = [
  { id: 'a', task: 'first job' },
  { id: 'b', task: 'second job' },
]

describe('the workflow tool', () => {
  test('fans out one child per task and brings every answer back', async () => {
    const started: Array<string> = []
    const agents = fakeAgents({ 'first job': 'one', 'second job': 'two' }, started)

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), { tasks }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual([
      { id: 'a', value: 'one' },
      { id: 'b', value: 'two' },
    ])
    expect(textOf(result)).toBe('a: one\nb: two')
    expect(started.sort()).toEqual(['first job', 'second job'])
  })

  test('an item that cannot be read as its expectation becomes null, and the rest live', async () => {
    const agents = fakeAgents({ 'first job': 'not json at all', 'second job': '{"ok":true}' }, [])

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        tasks: [
          { id: 'a', task: 'first job', expect: 'json' },
          { id: 'b', task: 'second job', expect: 'json' },
        ],
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual([
      { id: 'a', value: null, error: 'the answer is not JSON' },
      { id: 'b', value: { ok: true } },
    ])
    expect(textOf(result)).toContain('a: (failed: the answer is not JSON)')
    expect(textOf(result)).toContain('b: {"ok":true}')
  })

  test('tasks that name the same id are refused before anything runs', async () => {
    const started: Array<string> = []
    const agents = fakeAgents({}, started)

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        tasks: [
          { id: 'a', task: 'one' },
          { id: 'a', task: 'two' },
        ],
      }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('same id')
    expect(started).toEqual([])
  })

  test('a workflow at the depth limit is refused before anything runs', async () => {
    const started: Array<string> = []
    const agents = fakeAgents({ 'first job': 'one' }, started, { depth: 1 })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        tasks: [{ id: 'a', task: 'first job' }],
      }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('delegation depth')
    expect(started).toEqual([])
  })
})
const sandboxOf = (wraps: Array<ReadonlyArray<string>>): SandboxShape => ({
  name: 'test',
  confines: true,
  mode: 'workspace-write',
  wrap: (command) =>
    Effect.sync(() => {
      wraps.push(command.argv)
      return { ...command, mode: 'workspace-write' as const, denialSignatures: [] }
    }),
})

describe('the workflow script', () => {
  test('reads one child answer and chooses the next child from it', async () => {
    const started: Array<string> = []
    const agents = fakeAgents({ 'first job': 'draft', 'review: draft': 'done' }, started)

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: `
          console.log('draft first')
          const first = await workflow.spawn('first job', { label: 'draft' })
          const second = await workflow.spawn('review: ' + first.text, { label: 'review' })
          return second.text
        `,
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({ ok: true, children: 2, value: 'done' })
    expect(started).toEqual(['first job', 'review: draft'])
    expect(textOf(result)).toContain('workflow script: ok')
    expect(textOf(result)).toContain('draft first')
    expect(textOf(result)).toContain('return: "done"')
  })

  test('turns a script exception into a failed result instead of a failed call', async () => {
    const agents = fakeAgents({}, [])

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "throw new Error('boom')",
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({ ok: false, stage: 'script' })
    expect(reasonOf(result)).toContain('boom')
    expect(textOf(result)).toContain('failed at script')
  })

  test('turns a child that cannot start into a failed result at its spawn', async () => {
    const agents = fakeAgents({}, [], { failCreate: true })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "await workflow.spawn('first job')",
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({
      ok: false,
      stage: 'spawn 1',
      reason: 'cannot start a child agent',
    })
  })

  test('fails the run at the spawn that goes past the child limit', async () => {
    const started: Array<string> = []
    const agents = fakeAgents({ one: 'first', two: 'second' }, started)

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        maxChildren: 1,
        script: `
          await workflow.spawn('one')
          try {
            await workflow.spawn('two')
          } catch (error) {
            await workflow.spawn('three')
          }
          return 'caught'
        `,
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({
      ok: false,
      stage: 'spawn 2',
      children: 1,
    })
    expect(reasonOf(result)).toContain('more than 1 children')
    expect(started).toEqual(['one'])
  })

  test('runs the script in the sandbox and starts children the way subagent does', async () => {
    const wraps: Array<ReadonlyArray<string>> = []
    const created: Array<{
      readonly cwd: string
      readonly options: { readonly route: string }
      readonly parent: string
    }> = []
    const agents = fakeAgents({ 'first job': 'answer' }, [], { created })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model', sandbox: sandboxOf(wraps) }), {
        script: "return (await workflow.spawn('first job')).text",
      }),
    )

    expect(result?.value).toMatchObject({ ok: true, value: 'answer' })
    expect(wraps).toHaveLength(1)
    expect(wraps[0]?.[0]).toBe(process.execPath)
    expect(wraps[0]?.[1]).toBe('-e')
    expect(created).toEqual([
      { cwd: process.cwd(), options: { route: 'stub/model' }, parent: 's1', seed: [] },
    ])
  })

  test('fails a script that outlives the deadline at the timeout stage', async () => {
    const agents = fakeAgents({ 'slow job': 'late' }, [], { idle: Effect.sleep('2 seconds') })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model', timeoutMs: 250 }), {
        script: "await workflow.spawn('slow job')",
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({ ok: false, stage: 'timeout', children: 1 })
  })

  test('refuses a workflow that names both tasks and a script', async () => {
    const started: Array<string> = []
    const agents = fakeAgents({}, started)

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        tasks: [{ id: 'a', task: 'first job' }],
        script: 'return 1',
      }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('either tasks or script')
    expect(started).toEqual([])
  })
})

describe('the workflow child path', () => {
  test('starts a script child with the same arguments subagent uses', async () => {
    const created: Array<{
      readonly cwd: string
      readonly options: { readonly route: string }
      readonly parent: string
    }> = []
    const agents = fakeAgents({ 'first job': 'answer' }, [], { created })

    await Effect.runPromise(
      call(makeSubagentTool({ agents, route: 'stub/model' }), { task: 'first job' }),
    )
    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "return (await workflow.spawn('first job')).text",
      }),
    )

    expect(result?.value).toMatchObject({ ok: true, value: 'answer' })
    expect(created).toHaveLength(2)
    expect(created[1]).toEqual(created[0])
  })

  test('returns the child tool summaries to the script', async () => {
    const childEvents: ReadonlyArray<SessionEvent> = [
      {
        seq: 2,
        time: 0,
        type: 'tool/call',
        data: { callId: 't1', name: 'bash', arguments: '{}' },
      },
      {
        seq: 3,
        time: 0,
        type: 'tool/result',
        data: {
          callId: 't1',
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
          summary: 'ok',
        },
      },
    ]
    const agents = fakeAgents({ 'first job': 'answer' }, [], { childEvents })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "return (await workflow.spawn('first job')).tools",
      }),
    )

    expect(result?.value).toMatchObject({ ok: true, value: [{ name: 'bash', summary: 'ok' }] })
  })

  test('fails at the spawn when the child refuses the message', async () => {
    const agents = fakeAgents({}, [], { refuseFollowup: true })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "await workflow.spawn('first job')",
      }),
    )

    expect(result?.value).toMatchObject({
      ok: false,
      stage: 'spawn 1',
      reason: 'the child agent took no message',
    })
  })

  test('fails at the spawn when the task is empty', async () => {
    const agents = fakeAgents({}, [])

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "await workflow.spawn('')",
      }),
    )

    expect(result?.value).toMatchObject({
      ok: false,
      stage: 'spawn 1',
      reason: 'spawn needs a non-empty task',
      children: 0,
    })
  })

  test('fails before the script runs when the sandbox cannot wrap it', async () => {
    const sandbox: SandboxShape = {
      name: 'test',
      confines: true,
      mode: 'workspace-write',
      wrap: () => Effect.fail(new SandboxError({ message: 'no seatbelt today' })),
    }
    const agents = fakeAgents({}, [])

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model', sandbox }), {
        script: 'return 1',
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({
      ok: false,
      stage: 'sandbox',
      children: 0,
    })
    expect(reasonOf(result)).toContain('no seatbelt today')
  })

  test('fails at the spawn when the child turn ends in an error', async () => {
    const childEvents = [
      {
        seq: 2,
        time: 0,
        type: 'turn/end',
        data: {
          turn: 1,
          reason: {
            kind: 'error',
            failure: { _tag: 'LlmFailure', code: 'PROVIDER', message: 'provider fell over' },
          },
        },
      },
    ] as unknown as ReadonlyArray<SessionEvent>
    const agents = fakeAgents({ 'first job': 'partial' }, [], { childEvents })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "await workflow.spawn('first job')",
      }),
    )

    expect(result?.value).toMatchObject({
      ok: false,
      stage: 'spawn 1',
      reason: 'the child agent failed: provider fell over',
    })
  })
})

describe('workflow child failures', () => {
  test('a task whose child cannot start becomes a null item', async () => {
    const agents = fakeAgents({}, [], { failCreate: true })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        tasks: [{ id: 'a', task: 'first job' }],
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual([{ id: 'a', value: null, error: 'cannot start a child agent' }])
  })

  test('a task whose followup raises becomes a null item', async () => {
    const agents = fakeAgents({}, [], { failFollowup: true })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        tasks: [{ id: 'a', task: 'first job' }],
      }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual([
      { id: 'a', value: null, error: 'the child agent took no message' },
    ])
  })

  test('a script spawn whose followup raises fails at that stage', async () => {
    const agents = fakeAgents({}, [], { failFollowup: true })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "await workflow.spawn('first job')",
      }),
    )

    expect(result?.value).toMatchObject({
      ok: false,
      stage: 'spawn 1',
      reason: 'the child agent took no message',
    })
  })

  test('a script spawn whose child never becomes idle fails at that stage', async () => {
    const agents = fakeAgents({}, [], { failIdle: true })

    const result = await Effect.runPromise(
      call(makeWorkflowTool({ agents, route: 'stub/model' }), {
        script: "await workflow.spawn('first job')",
      }),
    )

    expect(result?.value).toMatchObject({
      ok: false,
      stage: 'spawn 1',
      reason: 'the child agent did not become idle',
    })
  })
})
