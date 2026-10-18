import { Schema, Effect } from 'effect'
import type { AgentsShape } from '@jozo-harness/agent'
import { forkSeed, type SessionEvent } from '@jozo-harness/session'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { delegationRefusal, eventsOfAgent } from './delegation.ts'
import {
  taskOf,
  teamRoster,
  teamTasks,
  type TeamMember,
  type TeamTask,
  type TeamTaskState,
} from './team-state.ts'

/** How a team call reads and writes the log of the agent that called it. */
export interface TeamLog {
  readonly events: (sessionId: string) => ReadonlyArray<SessionEvent>
  readonly spawnMember: (sessionId: string, member: TeamMember) => Effect.Effect<void, unknown>
  readonly createTask: (sessionId: string, task: TeamTask) => Effect.Effect<void, unknown>
  readonly updateTask: (sessionId: string, task: TeamTask) => Effect.Effect<void, unknown>
  /** Names the next board row. */
  readonly nextId: (sessionId: string) => string
}

export interface TeamHost {
  readonly agents: AgentsShape
  readonly route: string
  readonly log: TeamLog
}

const ACTIONS = ['list', 'spawn', 'create', 'get', 'update'] as const

const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      'list shows the roster and the board; spawn adds a named teammate; create, get, and update work the shared board.',
  }),
  name: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Lower-case teammate name, unique on the roster. With spawn.',
    }),
  ),
  role: Schema.optionalKey(
    Schema.String.annotate({ description: 'What that teammate is for, in one line. With spawn.' }),
  ),
  title: Schema.optionalKey(
    Schema.String.annotate({ description: 'The work to record. With create.' }),
  ),
  owner: Schema.optionalKey(
    Schema.String.annotate({ description: 'The teammate the work belongs to, if any.' }),
  ),
  id: Schema.optionalKey(
    Schema.String.annotate({ description: 'The board row. With get and update.' }),
  ),
  state: Schema.optionalKey(
    Schema.Literals(['pending', 'doing', 'done', 'blocked']).annotate({
      description: 'Where the row stands. With update.',
    }),
  ),
  revision: Schema.optionalKey(
    Schema.Int.annotate({
      description: 'The revision this call read; update refuses a row that has moved on since.',
    }),
  ),
})

export type TeamArgs = Schema.Schema.Type<typeof Parameters>

/** What a team call leaves behind: the roster and the board as they stand. */
export interface TeamValue {
  readonly action: string
  readonly members: ReadonlyArray<TeamMember>
  readonly tasks: ReadonlyArray<TeamTask>
}

const refuse = (message: string) => new ToolError({ code: 'invalid-arguments', message })

const required = (value: string | undefined, what: string): string | ToolError =>
  value === undefined || value.trim() === '' ? refuse(what + ' is required') : value

const memberLine = (member: TeamMember, agents: AgentsShape): string => {
  const agent = agents.get(member.sessionId)
  const doing = agent === undefined ? 'gone' : agent.status
  // The child's session id is how the model addresses it, spelled as subagent spells it.
  return (
    member.name + ' (' + doing + ') — ' + member.role + ' [child session: ' + member.sessionId + ']'
  )
}

const taskLine = (task: TeamTask): string =>
  task.id +
  ' ' +
  task.title +
  ' — ' +
  task.state +
  (task.owner === undefined ? '' : ', owner ' + task.owner) +
  ', revision ' +
  String(task.revision)

const render = (value: TeamValue, agents: AgentsShape): string => {
  const roster =
    value.members.length === 0
      ? 'roster: (nobody yet)'
      : value.members.map((member) => memberLine(member, agents)).join('\n')
  const board =
    value.tasks.length === 0
      ? 'board: (nothing yet)'
      : value.tasks.map((task) => taskLine(task)).join('\n')
  return roster + '\n' + board
}

const spawn = (host: TeamHost, args: TeamArgs, cwd: string, sessionId: string) =>
  Effect.gen(function* () {
    const name = required(args.name, 'name')
    if (name instanceof ToolError) return yield* Effect.fail(name)
    if (teamRoster(host.log.events(sessionId)).some((member) => member.name === name)) {
      return yield* Effect.fail(refuse(name + ' is already on the roster'))
    }
    const child = yield* host.agents
      .create({
        cwd,
        options: { route: host.route },
        seed: forkSeed(eventsOfAgent(host.agents, sessionId)),
        parent: sessionId,
      })
      .pipe(
        Effect.mapError(
          () => new ToolError({ code: 'execution', message: 'cannot start a teammate' }),
        ),
      )
    const member: TeamMember = { name, role: args.role ?? '', sessionId: child.id }
    yield* host.log.spawnMember(sessionId, member).pipe(Effect.orDie)
    return { action: 'spawn', members: [member], tasks: [] } satisfies TeamValue
  })

const create = (host: TeamHost, args: TeamArgs, sessionId: string) =>
  Effect.gen(function* () {
    const title = required(args.title, 'title')
    if (title instanceof ToolError) return yield* Effect.fail(title)
    const task: TeamTask = {
      id: host.log.nextId(sessionId),
      title,
      state: 'pending',
      revision: 1,
      ...(args.owner === undefined ? {} : { owner: args.owner }),
    }
    yield* host.log.createTask(sessionId, task).pipe(Effect.orDie)
    return { action: 'create', members: [], tasks: [task] } satisfies TeamValue
  })

const get = (host: TeamHost, args: TeamArgs, sessionId: string) =>
  Effect.gen(function* () {
    const task = taskOf(host.log.events(sessionId), String(args.id))
    if (task === undefined) {
      return yield* Effect.fail(refuse('no task with that id: ' + String(args.id)))
    }
    return { action: 'get', members: [], tasks: [task] } satisfies TeamValue
  })

/** The state a call moves a row to, refusing to move it after someone else did. */
const moved = (current: TeamTask, args: TeamArgs): TeamTask | ToolError => {
  if (args.revision !== undefined && args.revision !== current.revision) {
    return refuse(
      'this row has moved on: it is at revision ' +
        String(current.revision) +
        ', not ' +
        String(args.revision) +
        '; read it again',
    )
  }
  const state: TeamTaskState = args.state ?? current.state
  const owner = args.owner ?? current.owner
  return {
    id: current.id,
    title: current.title,
    state,
    revision: current.revision + 1,
    ...(owner === undefined ? {} : { owner }),
  }
}

const update = (host: TeamHost, args: TeamArgs, sessionId: string) =>
  Effect.gen(function* () {
    const current = taskOf(host.log.events(sessionId), String(args.id))
    if (current === undefined) {
      return yield* Effect.fail(refuse('no task with that id: ' + String(args.id)))
    }
    const task = moved(current, args)
    if (task instanceof ToolError) return yield* Effect.fail(task)
    yield* host.log.updateTask(sessionId, task).pipe(Effect.orDie)
    return { action: 'update', members: [], tasks: [task] } satisfies TeamValue
  })

/**
 * The lead's roster and board: named children it can message with the agent tools,
 * and shared work whose state lives in its own log. Nothing here is a new kind of
 * agent — a teammate is the same child the subagent tool starts.
 */
export const makeTeamTool = (host: TeamHost): ToolDefinition<TeamArgs, TeamValue> => ({
  name: 'team',
  description:
    'Keeps a roster of named teammates and a shared board of work. Spawn one teammate per name (a child agent like subagent starts), then hand work out with send_message and record where each piece stands with create, get, and update. Update refuses a row that moved on since it was read.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      action: Schema.String,
      members: Schema.Array(
        Schema.Struct({ name: Schema.String, role: Schema.String, sessionId: Schema.String }),
      ),
      tasks: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          state: Schema.Literals(['pending', 'doing', 'done', 'blocked']),
          owner: Schema.optionalKey(Schema.String),
          revision: Schema.Int,
        }),
      ),
    }),
    render: (_args, value) => [{ type: 'text', text: render(value, host.agents) }],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const refused = delegationRefusal(host.agents, context.sessionId)
      if (refused !== undefined) return yield* Effect.fail(refused)
      const sessionId = context.sessionId
      if (args.action === 'list') {
        return {
          action: 'list',
          members: teamRoster(host.log.events(sessionId)),
          tasks: teamTasks(host.log.events(sessionId)),
        } satisfies TeamValue
      }
      if (args.action === 'spawn') return yield* spawn(host, args, context.cwd, sessionId)
      if (args.action === 'create') return yield* create(host, args, sessionId)
      if (args.action === 'get') return yield* get(host, args, sessionId)
      return yield* update(host, args, sessionId)
    }),
})
