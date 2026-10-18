import type { Agent, AgentsShape } from '@jozo-harness/agent'
import { HooksLive } from '@jozo-harness/kernel'
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
import { makeWorkflowTool, type WorkflowTask } from '../src/index.ts'

/** What one child is told to answer, by the task it was given. */
type Answers = Readonly<Record<string, string>>

interface FakeAgentsOptions {
  readonly depth?: number
  readonly events?: ReadonlyArray<SessionEvent>
}

const fakeAgents = (
  answers: Answers,
  started: Array<string>,
  options: FakeAgentsOptions = {},
): AgentsShape => {
  let counter = 0
  return {
    create: () =>
      Effect.sync(() => {
        counter += 1
        let answer = ''
        const agent = {
          id: 'child-' + String(counter),
          session: {
            events: () => [
              {
                seq: 1,
                time: 0,
                type: 'assistant/message',
                data: { content: [{ type: 'text', text: answer }] },
              },
            ],
          },
          // The child answers whatever it is told, once it is told.
          followup: (message: { text: string }) =>
            Effect.sync(() => {
              started.push(message.text)
              answer = answers[message.text] ?? ''
            }),
          whenIdle: Effect.sleep('2 millis'),
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
        context: { sessionId: 's1', cwd: '/work', callId: 'c1' },
      })
    }),
  )

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

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
