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
  teamMessages,
  teamRoster,
  teamTasks,
  unreadMessages,
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

interface Assignment {
  readonly id: string
  readonly text: string
  readonly how: 'followup' | 'steer'
}

/** A log the tool writes to, with a lead and the children the Agents seam can look up. */
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
  const assigned: Array<Assignment> = []
  let seq = 0
  let counter = 0
  const write = (sessionId: string, type: string, data: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      seq += 1
      writes.push({ sessionId, type })
      eventsIn(sessionId).push(event(seq, type, data))
    })
  const follow = (id: string, how: Assignment['how']) => (message: { text: string }) =>
    Effect.sync(() => {
      assigned.push({ id, text: message.text, how })
    })
  // The lead is not in the children map, so a spawn keeps numbering from child-1.
  const lead = {
    id: 's1',
    status: 'idle',
    session: { events: () => eventsIn('s1') },
    followup: follow('s1', 'followup'),
    steer: follow('s1', 'steer'),
    dispose: () => Effect.void,
  } as unknown as Agent
  const log: TeamLog = {
    events: (sessionId) => eventsIn(sessionId),
    spawnMember: (sessionId, member) => write(sessionId, 'team/spawned', member),
    createTask: (sessionId, task) => write(sessionId, 'team/task/created', { task }),
    updateTask: (sessionId, task) => write(sessionId, 'team/task/updated', { task }),
    sendMessage: (sessionId, message) => write(sessionId, 'team/message', message),
    markMessagesRead: (sessionId, count) => write(sessionId, 'team/message/read', { count }),
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
          session: { events: () => eventsIn(id) },
          followup: follow(id, 'followup'),
          steer: follow(id, 'steer'),
          dispose: () => Effect.void,
        } as unknown as Agent
        children.set(id, agent)
        return agent
      }),
    get: (id: string) => (id === 's1' ? lead : children.get(id)),
    list: () => [lead, ...children.values()],
    childrenOf: () => [...children.values()],
    dispose: () => Effect.void,
    depthOf: () => options.depth ?? 0,
  } as unknown as AgentsShape
  return { log, events, writes, agents, children, assigned }
}

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
  sessionId = 's1',
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
        context: { sessionId, cwd: '/work', callId: 'c1' },
      })
    }),
  )

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

const teamTool = (team: ReturnType<typeof fakeTeam>) =>
  makeTeamTool({ agents: team.agents, route: 'stub/model', log: team.log })

describe('the team roster', () => {
  test('spawning names a child and records it', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)

    const result = await Effect.runPromise(
      call(tool, { action: 'spawn', name: 'builder', role: 'writes the code' }),
    )

    expect(result?.value).toMatchObject({
      members: [{ name: 'builder', sessionId: 'child-1' }],
    })
    expect(teamRoster(team.events)).toEqual([
      { name: 'builder', role: 'writes the code', sessionId: 'child-1' },
    ])
    expect(textOf(result)).toContain('builder')
  })

  test('a name is used once', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    const again = await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    expect(again?.isError).toBe(true)
    expect(textOf(again)).toContain('builder is already on the roster')
  })
})

describe('peer messages', () => {
  test('a teammate reaches another teammate without the lead', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'writer' }))

    const sent = await Effect.runPromise(
      call(tool, { action: 'send', to: 'writer', text: 'review the draft' }, 'child-1'),
    )

    expect(sent?.value).toMatchObject({
      messages: [
        {
          from: 'builder',
          fromSession: 'child-1',
          to: 'writer',
          text: 'review the draft',
        },
      ],
    })
    // The message lands in the recipient's own log, not the lead's board, and
    // the recipient is woken without the lead handing anything over.
    expect(teamMessages(team.log.events('s1'))).toEqual([])
    expect(teamMessages(team.log.events('child-2'))).toHaveLength(1)
    expect(team.assigned).toEqual([
      { id: 'child-2', text: 'peer message from builder: review the draft', how: 'followup' },
    ])
    expect(textOf(sent)).toContain('sent to writer: review the draft')

    const read = await Effect.runPromise(call(tool, { action: 'inbox' }, 'child-2'))

    expect(read?.value).toMatchObject({
      messages: [{ from: 'builder', to: 'writer', text: 'review the draft' }],
    })
    expect(unreadMessages(team.log.events('child-2'))).toEqual([])
    expect(textOf(read)).toContain('builder -> writer')
    expect(textOf(await Effect.runPromise(call(tool, { action: 'inbox' }, 'child-2')))).toContain(
      'inbox: (no new messages)',
    )
  })

  test('a message to a working teammate is queued for its next step', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'writer' }))
    const writer = team.agents.get('child-2') as unknown as { status: string }
    writer.status = 'running'

    await Effect.runPromise(
      call(tool, { action: 'send', to: 'writer', text: 'one more thing' }, 'child-1'),
    )

    expect(team.assigned).toEqual([
      { id: 'child-2', text: 'peer message from builder: one more thing', how: 'steer' },
    ])
  })

  test('a message to a name nobody holds is refused, and so is messaging yourself', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    const missing = await Effect.runPromise(
      call(tool, { action: 'send', to: 'ghost', text: 'hello' }),
    )
    const self = await Effect.runPromise(
      call(tool, { action: 'send', to: 'builder', text: 'hello' }, 'child-1'),
    )

    expect(missing?.isError).toBe(true)
    expect(textOf(missing)).toContain('no teammate named ghost on the roster')
    expect(self?.isError).toBe(true)
    expect(textOf(self)).toContain('builder is you')
    expect(teamMessages(team.log.events('child-1'))).toEqual([])
  })

  test('a teammate can read the board and its inbox, and the lead reads no peer inbox', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'writer' }))
    await Effect.runPromise(call(tool, { action: 'create', title: 'write the guide' }))
    await Effect.runPromise(
      call(tool, { action: 'send', to: 'writer', text: 'start now' }, 'child-1'),
    )

    const listed = await Effect.runPromise(call(tool, { action: 'list' }, 'child-2'))
    const lead = await Effect.runPromise(call(tool, { action: 'inbox' }))

    expect(textOf(listed)).toContain('builder (idle)')
    expect(textOf(listed)).toContain('task-1 write the guide — pending')
    expect(lead?.value).toMatchObject({ messages: [] })
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
    const tool = teamTool(team)

    const made = await Effect.runPromise(call(tool, { action: 'create', title: 'write the guide' }))
    const moved = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-1', state: 'done', revision: 1 }),
    )

    expect(made?.value).toMatchObject({
      tasks: [{ id: 'task-1', state: 'pending', revision: 1 }],
    })
    expect(moved?.value).toMatchObject({ tasks: [{ id: 'task-1', state: 'done', revision: 2 }] })
    expect(team.events.map((each) => each.type)).toEqual(['team/task/created', 'team/task/updated'])
  })

  test('a stale revision is refused, and so is an unknown task', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
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
    const tool = teamTool(team)
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
    const tool = teamTool(team)

    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    expect(team.writes).toEqual([{ sessionId: 's1', type: 'team/spawned' }])
    expect(team.events.map((each) => each.type)).toEqual(['team/spawned'])
  })

  test('a teammate at the depth limit is refused', async () => {
    const team = fakeTeam({ depth: 1 })
    const tool = teamTool(team)

    const result = await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('delegation depth')
    expect(team.children.size).toBe(0)
  })

  test('a task waits for the tasks it names before it can be done', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'create', title: 'draft' }))
    await Effect.runPromise(
      call(tool, { action: 'create', title: 'publish', blockedBy: ['task-1'] }),
    )

    const early = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-2', state: 'done', revision: 1 }),
    )

    expect(early?.isError).toBe(true)
    expect(textOf(early)).toContain('waiting on task-1 (pending)')

    await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-1', state: 'done', revision: 1 }),
    )
    const done = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-2', state: 'done', revision: 1 }),
    )

    expect(done?.value).toMatchObject({ tasks: [{ id: 'task-2', state: 'done' }] })
    expect(textOf(await Effect.runPromise(call(tool, { action: 'list' })))).toContain(
      'task-2 publish — done, waits on task-1, revision 2',
    )
  })

  test('a dependency on an id the board does not have is refused', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'create', title: 'draft' }))

    const result = await Effect.runPromise(
      call(tool, { action: 'create', title: 'publish', blockedBy: ['task-9'] }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('no task with that id: task-9')
  })

  test('a dependency loop is refused, whether the row is created or moved', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    // The next id is task-1, so waiting on it is a row waiting on itself.
    const self = await Effect.runPromise(
      call(tool, { action: 'create', title: 'draft', blockedBy: ['task-1'] }),
    )
    expect(self?.isError).toBe(true)
    expect(textOf(self)).toContain('cycle')

    // The refused create still took a number from this log's id counter.
    await Effect.runPromise(call(tool, { action: 'create', title: 'draft' }))
    await Effect.runPromise(
      call(tool, { action: 'create', title: 'publish', blockedBy: ['task-2'] }),
    )
    const loop = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-2', blockedBy: ['task-3'], revision: 1 }),
    )

    expect(loop?.isError).toBe(true)
    expect(textOf(loop)).toContain('cycle')
  })

  test('a teammate cannot take the lead-only actions', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'writer' }))
    await Effect.runPromise(
      call(tool, { action: 'create', title: 'write the guide', owner: 'builder' }),
    )

    const spawned = await Effect.runPromise(
      call(tool, { action: 'spawn', name: 'other' }, 'child-1'),
    )
    const created = await Effect.runPromise(
      call(tool, { action: 'create', title: 'another task' }, 'child-1'),
    )
    const reassigned = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-1', owner: 'writer', revision: 1 }, 'child-1'),
    )
    const someoneElse = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-1', state: 'done', revision: 1 }, 'child-2'),
    )

    expect(spawned?.isError).toBe(true)
    expect(textOf(spawned)).toContain('Team Lead')
    expect(created?.isError).toBe(true)
    expect(textOf(created)).toContain('Team Lead')
    expect(reassigned?.isError).toBe(true)
    expect(textOf(reassigned)).toContain('assigning work is the Team Lead')
    expect(someoneElse?.isError).toBe(true)
    expect(textOf(someoneElse)).toContain('belongs to builder')
    expect(team.children.size).toBe(2)
  })

  test('a teammate completes the task it owns', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)
    await Effect.runPromise(call(tool, { action: 'spawn', name: 'builder' }))
    await Effect.runPromise(
      call(tool, { action: 'create', title: 'write the guide', owner: 'builder' }),
    )

    const done = await Effect.runPromise(
      call(tool, { action: 'update', id: 'task-1', state: 'done', revision: 1 }, 'child-1'),
    )

    expect(done?.value).toMatchObject({ tasks: [{ id: 'task-1', state: 'done', revision: 2 }] })
    expect(teamTasks(team.events)).toEqual([
      {
        id: 'task-1',
        title: 'write the guide',
        state: 'done',
        revision: 2,
        owner: 'builder',
      },
    ])
  })

  test('a task cannot be assigned to a name that is not on the roster', async () => {
    const team = fakeTeam()
    const tool = teamTool(team)

    const result = await Effect.runPromise(
      call(tool, { action: 'create', title: 'write the guide', owner: 'ghost' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('no teammate named ghost on the roster')
  })
})
