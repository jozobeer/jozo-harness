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
import { makeSubagentTool } from '../src/index.ts'

const childEvents = (text: string): Array<SessionEvent> =>
  [
    {
      seq: 1,
      time: 0,
      type: 'session/header',
      data: { formatVersion: 1, createdAt: 0, cwd: '/tmp' },
    },
    {
      seq: 2,
      time: 0,
      type: 'assistant/message',
      data: { content: [{ type: 'text', text }] },
    },
  ] as unknown as Array<SessionEvent>

interface Created {
  readonly cwd: string
  readonly task: string
  readonly route: string | undefined
  readonly seed: ReadonlyArray<SessionEvent> | undefined
  readonly parent: string | undefined
}

const fakeAgents = (seen: Array<Created>, text: string): AgentsShape =>
  ({
    create: (options: {
      cwd: string
      options?: { readonly route?: string }
      seed?: ReadonlyArray<SessionEvent>
      parent?: string
    }) => {
      seen.push({
        cwd: options.cwd,
        task: '',
        route: options.options?.route,
        seed: options.seed,
        parent: options.parent,
      })
      const agent = {
        id: 'child-1',
        session: { events: () => childEvents(text) },
        followup: (message: { text: string }) =>
          Effect.sync(() => {
            const last = seen[seen.length - 1]
            if (last !== undefined) seen[seen.length - 1] = { ...last, task: message.text }
          }),
        whenIdle: Effect.void,
      } as unknown as Agent
      return Effect.succeed(agent)
    },
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

describe('subagent tool', () => {
  test('runs the task in a child and returns its answer', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'child says hi'),
          route: 'stub/model',
          parentEvents: () => [],
        }),
        {
          task: 'look around',
        },
      ),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual({ sessionId: 'child-1', text: 'child says hi' })
    expect(JSON.stringify(result?.content)).toContain('[child session: child-1]')
    expect(seen).toEqual([
      { cwd: '/work', task: 'look around', route: 'stub/model', seed: [], parent: 's1' },
    ])
  })

  test('takes the cwd it is given', async () => {
    const seen: Array<Created> = []
    await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'ok'),
          route: 'stub/model',
          parentEvents: () => [],
        }),
        {
          task: 'go',
          cwd: '/elsewhere',
        },
      ),
    )

    expect(seen[0]?.cwd).toBe('/elsewhere')
  })

  test('a child can run on another route', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'child says hi'),
          route: 'stub/model',
          parentEvents: () => [],
        }),
        { task: 'look around', model: 'other/cheap-model' },
      ),
    )

    expect(seen[0]?.route).toBe('other/cheap-model')
    expect(result?.isError).toBe(false)
  })

  test('a route has to name a provider and a model', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'ok'),
          route: 'stub/model',
          parentEvents: () => [],
        }),
        { task: 'look around', model: 'cheap-model' },
      ),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('provider and a model')
    // No child was started for a call that could never run.
    expect(seen).toEqual([])
  })

  test('a child can be left idle, and start from nothing', async () => {
    const seen: Array<Created> = []
    const parent = [
      {
        seq: 1,
        time: 1,
        type: 'user/message',
        data: { text: 'earlier', source: 'user' },
      } as unknown as SessionEvent,
    ]
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, ''),
          route: 'stub/model',
          parentEvents: () => parent,
        }),
        { context: 'fresh' },
      ),
    )

    expect(seen).toEqual([{ cwd: '/work', task: '', route: 'stub/model', seed: [], parent: 's1' }])
    expect(result?.value).toEqual({ sessionId: 'child-1', text: '' })
    expect(JSON.stringify(result?.content)).toContain('send_message')
  })
})
