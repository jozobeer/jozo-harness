import type { Agent, AgentStatus, AgentsShape } from '@jozo-harness/agent'
import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  agentTools,
  makeInterruptAgentTool,
  makeSendMessageTool,
  makeWaitAgentTool,
} from '../src/index.ts'

/** A child agent that writes down what the parent asked of it. */
const childAgent = (id: string, status: AgentStatus, seen: Array<string>, parent?: string): Agent =>
  ({
    id,
    status,
    parent,
    followup: (message: { text: string }) =>
      Effect.sync(() => {
        seen.push('followup ' + message.text)
      }),
    steer: (message: { text: string }) =>
      Effect.sync(() => {
        seen.push('steer ' + message.text)
      }),
    cancel: (cause: string) =>
      Effect.sync(() => {
        seen.push('cancel ' + cause)
      }),
    whenIdle: Effect.sleep('5 millis'),
  }) as unknown as Agent

const fakeAgents = (children: ReadonlyArray<Agent>): AgentsShape =>
  ({
    get: (id: string) => children.find((child) => child.id === id),
    list: () => children,
    childrenOf: (id: string) =>
      children.filter((child) => (child as { parent?: string }).parent === id),
  }) as unknown as AgentsShape

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

describe('the tools that steer child agents', () => {
  test('lists the children and their state, never the caller', async () => {
    const children = [childAgent('s1', 'running', []), childAgent('child-1', 'idle', [], 's1')]
    const tool = agentTools(fakeAgents(children)).find((each) => each.name === 'list_agents')

    const result = await Effect.runPromise(call(tool as ToolDefinition<any, any>, {}))

    expect(result?.value).toEqual([{ id: 'child-1', status: 'idle' }])
    expect(textOf(result)).toBe('child-1 idle')
  })

  test('a message to an idle child starts a turn, to a busy one it waits its step', async () => {
    const seen: Array<string> = []
    const idle = fakeAgents([childAgent('child-1', 'idle', seen, 's1')])
    const busy = fakeAgents([childAgent('child-1', 'running', seen, 's1')])

    const first = await Effect.runPromise(
      call(makeSendMessageTool(idle), { id: 'child-1', message: 'go on' }),
    )
    const second = await Effect.runPromise(
      call(makeSendMessageTool(busy), { id: 'child-1', message: 'change of plan' }),
    )

    expect(seen).toEqual(['followup go on', 'steer change of plan'])
    expect(first?.value).toEqual({ id: 'child-1', queued: false })
    expect(second?.value).toEqual({ id: 'child-1', queued: true })
    expect(textOf(second)).toContain('queued')
  })

  test('this session and unknown ids are refused', async () => {
    const agents = fakeAgents([childAgent('child-1', 'idle', [], 's1')])

    const itself = await Effect.runPromise(
      call(makeSendMessageTool(agents), { id: 's1', message: 'x' }),
    )
    const missing = await Effect.runPromise(
      call(makeSendMessageTool(agents), { id: 'nowhere', message: 'x' }),
    )

    expect(itself?.isError).toBe(true)
    expect(JSON.stringify(itself?.content)).toContain('this session')
    expect(missing?.isError).toBe(true)
    expect(JSON.stringify(missing?.content)).toContain('unknown agent')
  })

  test("another session's agent is neither listed nor reachable", async () => {
    const seen: Array<string> = []
    const agents = fakeAgents([
      childAgent('child-1', 'idle', seen, 's1'),
      childAgent('other-1', 'running', seen, 's2'),
    ])
    const listed = await Effect.runPromise(
      call(
        agentTools(agents).find((each) => each.name === 'list_agents') as ToolDefinition<any, any>,
        {},
      ),
    )
    const sent = await Effect.runPromise(
      call(makeSendMessageTool(agents), { id: 'other-1', message: 'x' }),
    )

    expect(listed?.value).toEqual([{ id: 'child-1', status: 'idle' }])
    expect(sent?.isError).toBe(true)
    expect(JSON.stringify(sent?.content)).toContain('not a child')
    expect(seen).toEqual([])
  })

  test('interrupting a child cancels it as its parent', async () => {
    const seen: Array<string> = []
    const agents = fakeAgents([childAgent('child-1', 'running', seen, 's1')])

    const result = await Effect.runPromise(call(makeInterruptAgentTool(agents), { id: 'child-1' }))

    expect(seen).toEqual(['cancel parent-cancelled'])
    expect(textOf(result)).toBe('interrupted child-1')
  })

  test('waiting reports whether the child finished in time', async () => {
    const quick = fakeAgents([childAgent('child-1', 'idle', [], 's1')])
    const slow = fakeAgents([
      {
        ...childAgent('child-2', 'running', [], 's1'),
        whenIdle: Effect.sleep('200 millis'),
      } as unknown as Agent,
    ])

    const finished = await Effect.runPromise(call(makeWaitAgentTool(quick), { id: 'child-1' }))
    const waiting = await Effect.runPromise(
      call(makeWaitAgentTool(slow), { id: 'child-2', timeoutMs: 10 }),
    )

    expect(finished?.value).toEqual({ id: 'child-1', idle: true })
    expect(waiting?.value).toEqual({ id: 'child-2', idle: false })
    expect(textOf(waiting)).toContain('still working')
  })
})
