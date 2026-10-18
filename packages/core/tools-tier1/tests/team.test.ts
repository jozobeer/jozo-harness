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
import {
  makeTeamTool,
  taskOf,
  teamRoster,
  teamTasks,
  type TeamLog,
  type TeamTask,
} from '../src/index.ts'

const event = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ seq, time: seq, type, data }) as unknown as SessionEvent

const createdTask = (seq: number, task: TeamTask): SessionEvent =>
  event(seq, 'team/task/created', { task })

const updatedTask = (seq: number, task: TeamTask): SessionEvent =>
  event(seq, 'team/task/updated', { task })

interface FakeTeamOptions {
  readonly depth?: number
}

/** A log the tool writes to, with children the Agents seam can look up. */
const fakeTeam = (options: FakeTeamOptions = {}) => {
  const eventsBySession = new Map<string, Array<SessionEvent>>()
  const writes: Array<{ sessionId: string; type: string }> = []
  const eventsIn = (sessionId: string): Array<SessionEvent> => {
    const stored = eventsBySession.get(sessionId)
    if (stored !== undefined) return stored
    const created: Array<SessionEvent> = []
    eventsBySession.set(sessionId, created)
    return created
  }
  const events = eventsIn('s1')
  const children = new Map<string, Agent>()
  const assigned: Array<{ id: string; text: string }> = []
  let seq = 0
  let counter = 0
  const write = (sessionId: string, type: string, data: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      seq += 1
      writes.push({ sessionId, type })
      eventsIn(sessionId).push(event(seq, type, data))
    })
  const log: TeamLog = {
    events: (sessionId) => eventsIn(sessionId),
    spawnMember: (sessionId, member) => write(sessionId, 'team/spawned', member),
    createTask: (sessionId, task) => write(sessionId, 'team/task/created', { task }),
    updateTask: (sessionId, task) => write(sessionId, 'team/task/updated', { task }),
    nextId: (_sessionId) => {
      counter += 1
      return 'task-' + String(counter)
    },
  }
  const agents = {
    create: () =>
      Effect.sync(() => {
        const id = 'child-' + String(children.size + 1)
        const agent = {
          id,
          status: 'idle',
          session: { events: () => [] },
          followup: (message: { text: string }) =>
            Effect.sync(() => {
              assigned.push({ id, text: message.text })
            }),
          dispose: () => Effect.void,
        } as unknown as Agent
        children.set(id, agent)
        return agent
      }),
    get: (id: string) => children.get(id),
    list: () => [...children.values()],
    dispose: () => Effect.void,
    depthOf: () => options.depth ?? 0,
  } as unknown as AgentsShape
  return { log, events, writes, agents, children, assigned }
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

describe('the team roster', () => {
  test('spawning names a child and records it', async () => {
    const team = fakeTeam()
    const tool = makeTeamTool({
      agents: team.agents,
      route: 'stub/model',
      log: team.log,
    })

    const result = await Effect.runPromise(
      call(tool, { action: 'spawn', name: 'builder', role: 'writes the code' }),
    )

    expect(result?.value).toMatchObject({ members: [{ name: 'builder', sessionId: 'child-1' }] })
    expect(teamRoster(team.events)).toEqual([
      { name: 'builder', role: 'writes the code', sessionId: 'child-1' },
    ])
    expect(textOf(result)).toContain('builder')
  })

  test('a name is used once', async () => {
    const team = fakeTeam()
    const tool = makeTeamTool({
      agents: team.agents,
      route: 'stub/model',
      log: team.log,
    })
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    const again = await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    expect(again?.isError).toBe(true)
    expect(textOf(again)).toContain('builder is already on the roster')
  })
})

describe('the team board', () => {
  const task = (id: string, state: TeamTask['state'] = 'pending'): TeamTask => ({
    id,
    title: 'write it',
    state,
    revision: 1,
  })

  test('is folded from the log, newest revision winning', () => {
    const events = [
      createdTask(1, task('task-1')),
      updatedTask(2, { ...task('task-1', 'doing'), revision: 2 }),
      updatedTask(3, { ...task('task-1', 'done'), revision: 3, owner: 'builder' }),
    ]

    expect(teamTasks(events)).toEqual([
      { id: 'task-1', title: 'write it', state: 'done', revision: 3, owner: 'builder' },
    ])
    expect(taskOf(events, 'task-1')?.revision).toBe(3)
    expect(taskOf(events, 'nowhere')).toBeUndefined()
  })

  test('creating and moving a task writes one event each', async () => {
    const team = fakeTeam()
    const tool = makeTeamTool({
      agents: team.agents,
      route: 'stub/model',
      log: team.log,
    })

    const made = await Effect.runPromise(call(tool, { action: 'create', title: 'write the guide' }))
    const moved = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-1', state: 'done', revision: 1 }),
    )

    expect(made?.value).toMatchObject({ tasks: [{ id: 'task-1', state: 'pending', revision: 1 }] })
    expect(moved?.value).toMatchObject({ tasks: [{ id: 'task-1', state: 'done', revision: 2 }] })
    expect(team.events.map((each) => each.type)).toEqual(['team/task/created', 'team/task/updated'])
  })

  test('a stale revision is refused, and so is an unknown task', async () => {
    const team = fakeTeam()
    const tool = makeTeamTool({
      agents: team.agents,
      route: 'stub/model',
      log: team.log,
    })
    await Effect.runPromise(call(tool, { action: 'create', title: 'write the guide' }))
    await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-1', state: 'doing', revision: 1 }),
    )

    const stale = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-1', state: 'done', revision: 1 }),
    )
    const missing = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-9', state: 'done', revision: 1 }),
    )

    expect(stale?.isError).toBe(true)
    expect(textOf(stale)).toContain('revision 2')
    expect(missing?.isError).toBe(true)
    expect(textOf(missing)).toContain('no task with that id: task-9')
  })

  test('a list shows the roster with what each member is doing, and the tasks', async () => {
    const team = fakeTeam()
    const tool = makeTeamTool({
      agents: team.agents,
      route: 'stub/model',
      log: team.log,
    })
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))
    await Effect.runPromise(
      call(tool, { action: 'create', title: 'write the guide', owner: 'builder' }),
    )

    const listed = await Effect.runPromise(call(tool, { action: 'list' }))

    expect(textOf(listed)).toContain('builder (idle)')
    expect(textOf(listed)).toContain('task-1 write the guide — pending, owner builder, revision 1')
  })

  test('the roster lands in the log of the agent that called team', async () => {
    const team = fakeTeam()
    const tool = makeTeamTool({
      agents: team.agents,
      route: 'stub/model',
      log: team.log,
    })

    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    expect(team.writes).toEqual([{ sessionId: 's1', type: 'team/spawned' }])
    expect(team.events.map((each) => each.type)).toEqual(['team/spawned'])
  })

  test('a teammate at the depth limit is refused', async () => {
    const team = fakeTeam({ depth: 1 })
    const tool = makeTeamTool({
      agents: team.agents,
      route: 'stub/model',
      log: team.log,
    })

    const result = await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('delegation depth')
    expect(team.children.size).toBe(0)
  })
})
