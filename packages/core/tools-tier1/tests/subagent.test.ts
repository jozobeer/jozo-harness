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
import { makeStructuredOutputs, makeSubagentTool, type StructuredOutputs } from '../src/index.ts'

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
  readonly preset: string | undefined
  readonly seed: ReadonlyArray<SessionEvent> | undefined
  readonly parent: string | undefined
}

interface FakeAgentsOptions {
  readonly depth?: number
  readonly events?: ReadonlyArray<SessionEvent>
  readonly outputs?: StructuredOutputs
  readonly report?: unknown
}

const fakeAgents = (
  seen: Array<Created>,
  text: string,
  options: FakeAgentsOptions = {},
): AgentsShape => {
  const caller = {
    id: 'caller-1',
    session: { events: () => options.events ?? [] },
  } as unknown as Agent
  return {
    create: (createOptions: {
      cwd: string
      options?: { readonly route?: string; readonly preset?: string }
      seed?: ReadonlyArray<SessionEvent>
      parent?: string
    }) => {
      seen.push({
        cwd: createOptions.cwd,
        task: '',
        route: createOptions.options?.route,
        preset: createOptions.options?.preset,
        seed: createOptions.seed,
        parent: createOptions.parent,
      })
      const agent = {
        id: 'child-1',
        session: { events: () => childEvents(text) },
        followup: (message: { text: string }) =>
          Effect.sync(() => {
            const last = seen[seen.length - 1]
            if (last !== undefined) seen[seen.length - 1] = { ...last, task: message.text }
            if (options.outputs !== undefined && options.report !== undefined) {
              options.outputs.report('child-1', options.report)
            }
          }),
        whenIdle: Effect.void,
      } as unknown as Agent
      return Effect.succeed(agent)
    },
    get: (id: string) => (id === 's1' ? caller : undefined),
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

describe('subagent tool', () => {
  test('runs the task in a child and returns its answer', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'child says hi'),
          route: 'stub/model',
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
        }),
        {
          task: 'go',
          cwd: '/elsewhere',
        },
      ),
    )

    expect(seen[0]?.cwd).toBe('/elsewhere')
  })

  test('a child can run on another route the run offers', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'child says hi'),
          route: 'stub/model',
          routes: ['stub/model', 'other/cheap-model'],
        }),
        { task: 'look around', model: 'other/cheap-model' },
      ),
    )

    expect(seen[0]?.route).toBe('other/cheap-model')
    expect(result?.isError).toBe(false)
  })

  test('a route the run does not offer refuses before a child starts', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'child says hi'),
          route: 'stub/model',
          routes: ['stub/model', 'other/cheap-model'],
        }),
        { task: 'look around', model: 'other/unlisted' },
      ),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('not a route this run offers children')
    expect(JSON.stringify(result?.content)).toContain('offered: stub/model, other/cheap-model')
    expect(seen).toEqual([])
  })

  test('the route of the parent is taken as the run spells it', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'ok'),
          route: 'deepseek-v4.1-flash',
          routes: ['deepseek-v4.1-flash'],
        }),
        { task: 'look around', model: 'deepseek-v4.1-flash' },
      ),
    )

    expect(seen[0]?.route).toBe('deepseek-v4.1-flash')
    expect(result?.isError).toBe(false)
  })

  test('the parent picks the preset the child runs under from the allowed list', async () => {
    const seen: Array<Created> = []
    await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'ok'),
          route: 'stub/model',
          presets: { allowed: ['explore', 'review'] },
        }),
        { task: 'look around', preset: 'explore' },
      ),
    )

    expect(seen[0]?.preset).toBe('explore')
  })

  test('the default preset applies when the parent names none', async () => {
    const seen: Array<Created> = []
    await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'ok'),
          route: 'stub/model',
          presets: { allowed: ['explore'], default: 'explore' },
        }),
        { task: 'look around' },
      ),
    )

    expect(seen[0]?.preset).toBe('explore')
  })

  test('a preset outside the allowed list refuses before a child starts', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'ok'),
          route: 'stub/model',
          presets: { allowed: ['explore'] },
        }),
        { task: 'look around', preset: 'review' },
      ),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('not an allowed agent preset')
    expect(seen).toEqual([])
  })

  test('a route has to name a provider and a model', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'ok'),
          route: 'stub/model',
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
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, ''),
          route: 'stub/model',
        }),
        { context: 'fresh' },
      ),
    )

    expect(seen).toEqual([{ cwd: '/work', task: '', route: 'stub/model', seed: [], parent: 's1' }])
    expect(result?.value).toEqual({ sessionId: 'child-1', text: '' })
    expect(JSON.stringify(result?.content)).toContain('send_message')
  })

  test('a child at the depth limit refuses to delegate', async () => {
    const seen: Array<Created> = []
    const result = await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'unused', { depth: 1 }),
          route: 'stub/model',
        }),
        { task: 'delegate deeper' },
      ),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('delegation depth')
    expect(seen).toEqual([])
  })

  test('a forked child starts from the log of the agent that called it', async () => {
    const seen: Array<Created> = []
    const earlier = [
      {
        seq: 1,
        time: 1,
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: 'what this agent did' }] },
      } as unknown as SessionEvent,
      {
        seq: 2,
        time: 2,
        type: 'user/message',
        data: { text: 'the instruction in flight', source: 'user' },
      } as unknown as SessionEvent,
    ]
    await Effect.runPromise(
      call(
        makeSubagentTool({
          agents: fakeAgents(seen, 'ok', { events: earlier }),
          route: 'stub/model',
        }),
        { task: 'carry on' },
      ),
    )

    // forkSeed drops the trailing instruction and keeps what the caller had done.
    expect(seen[0]?.seed?.map((event) => event.type)).toEqual(['assistant/message'])
  })
})
test('a child answers through structured_output and the parent gets the checked value', async () => {
  const seen: Array<Created> = []
  const outputs = makeStructuredOutputs()
  const result = await Effect.runPromise(
    call(
      makeSubagentTool({
        agents: fakeAgents(seen, 'done', { outputs, report: { summary: 'done', score: 3 } }),
        route: 'stub/model',
        outputs,
      }),
      {
        task: 'look around',
        outputSchema: {
          type: 'object',
          properties: { summary: { type: 'string' }, score: { type: 'integer' } },
          required: ['summary'],
        },
      },
    ),
  )

  expect(result?.isError).toBe(false)
  expect(result?.value).toEqual({
    sessionId: 'child-1',
    text: 'done',
    structured: { value: { summary: 'done', score: 3 } },
  })
  // The child cannot see the schema in the declaration, so the task carries it.
  expect(seen[0]?.task).toContain('structured_output')
  expect(seen[0]?.task).toContain('"summary"')
  expect(JSON.stringify(result?.content)).toContain('structured report')
})

test('a child that never reports fails the call instead of passing as done', async () => {
  const seen: Array<Created> = []
  const outputs = makeStructuredOutputs()
  const result = await Effect.runPromise(
    call(
      makeSubagentTool({
        agents: fakeAgents(seen, 'I think it is fine', { outputs }),
        route: 'stub/model',
        outputs,
      }),
      {
        task: 'look around',
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    ),
  )

  expect(result?.isError).toBe(true)
  expect(JSON.stringify(result?.content)).toContain('without a structured report')
  expect(JSON.stringify(result?.content)).toContain('I think it is fine')
})

test('a host that cannot take reports refuses the schema before a child starts', async () => {
  const seen: Array<Created> = []
  const result = await Effect.runPromise(
    call(makeSubagentTool({ agents: fakeAgents(seen, 'ok'), route: 'stub/model' }), {
      task: 'look around',
      outputSchema: { type: 'object', properties: {} },
    }),
  )

  expect(result?.isError).toBe(true)
  expect(JSON.stringify(result?.content)).toContain('cannot take a structured report')
  expect(seen).toEqual([])
})

test('a schema needs a task, because an idle child has nothing to report', async () => {
  const seen: Array<Created> = []
  const outputs = makeStructuredOutputs()
  const result = await Effect.runPromise(
    call(
      makeSubagentTool({
        agents: fakeAgents(seen, '', { outputs }),
        route: 'stub/model',
        outputs,
      }),
      { outputSchema: { type: 'object', properties: {} } },
    ),
  )

  expect(result?.isError).toBe(true)
  expect(JSON.stringify(result?.content)).toContain('needs a task')
  expect(seen).toEqual([])
})
