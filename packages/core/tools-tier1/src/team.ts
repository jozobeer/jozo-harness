import { Schema, Effect } from 'effect'
import type { AgentsShape } from '@jozo-harness/agent'
import { forkSeed, type SessionEvent } from '@jozo-harness/session'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { delegationRefusal, eventsOfAgent } from './delegation.ts'
import { leadOnlyRefusal, teamActorOf, type TeamActor } from './team-actor.ts'
import { cycleIn, unresolved } from './team-graph.ts'
import {
  blockedByOf,
  taskOf,
  teamMessages,
  teamRoster,
  teamTasks,
  unreadMessages,
  type TeamMember,
  type TeamMessage,
  type TeamTask,
  type TeamTaskState,
} from './team-state.ts'

/** How a team call reads and writes the log of the agent that called it. */
export interface TeamLog {
  readonly events: (sessionId: string) => ReadonlyArray<SessionEvent>
  readonly spawnMember: (sessionId: string, member: TeamMember) => Effect.Effect<void, unknown>
  readonly createTask: (sessionId: string, task: TeamTask) => Effect.Effect<void, unknown>
  readonly updateTask: (sessionId: string, task: TeamTask) => Effect.Effect<void, unknown>
  /** Writes a peer message into the recipient's own log, where its inbox reads it. */
  readonly sendMessage: (sessionId: string, message: TeamMessage) => Effect.Effect<void, unknown>
  readonly markMessagesRead: (sessionId: string, count: number) => Effect.Effect<void, unknown>
  /** Names the next board row. */
  readonly nextId: (sessionId: string) => string
}

export interface TeamHost {
  readonly agents: AgentsShape
  readonly route: string
  readonly log: TeamLog
}

const ACTIONS = ['list', 'spawn', 'create', 'get', 'update', 'send', 'inbox'] as const

const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      'list shows the roster, the board, and the inbox; spawn adds a named teammate; create, get, and update work the shared board; send leaves another teammate a message; inbox reads and marks messages read.',
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
  blockedBy: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        'The task ids this task waits on. With create and update; the task cannot be done while any of them is open.',
    }),
  ),
  to: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The roster name of the teammate to message. With send.',
    }),
  ),
  text: Schema.optionalKey(Schema.String.annotate({ description: 'What to say. With send.' })),
  revision: Schema.optionalKey(
    Schema.Int.annotate({
      description: 'The revision this call read; update refuses a row that has moved on since.',
    }),
  ),
})

export type TeamArgs = Schema.Schema.Type<typeof Parameters>

/** What a team call leaves behind: the roster, the board, and the messages it touched. */
export interface TeamValue {
  readonly action: string
  readonly members: ReadonlyArray<TeamMember>
  readonly tasks: ReadonlyArray<TeamTask>
  readonly messages: ReadonlyArray<TeamMessage>
}

const refuse = (message: string) => new ToolError({ code: 'invalid-arguments', message })

const required = (value: string | undefined, what: string): string | ToolError =>
  value === undefined || value.trim() === '' ? refuse(what + ' is required') : value

const unique = (ids: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(ids)]

const value = (
  action: string,
  members: ReadonlyArray<TeamMember> = [],
  tasks: ReadonlyArray<TeamTask> = [],
  messages: ReadonlyArray<TeamMessage> = [],
): TeamValue => ({ action, members, tasks, messages })

const memberLine = (member: TeamMember, agents: AgentsShape): string => {
  const agent = agents.get(member.sessionId)
  const doing = agent === undefined ? 'gone' : agent.status
  // The child's session id is how the model addresses it, spelled as subagent spells it.
  return (
    member.name + ' (' + doing + ') — ' + member.role + ' [child session: ' + member.sessionId + ']'
  )
}

const taskLine = (task: TeamTask): string => {
  const waits = blockedByOf(task)
  return (
    task.id +
    ' ' +
    task.title +
    ' — ' +
    task.state +
    (task.owner === undefined ? '' : ', owner ' + task.owner) +
    (waits.length === 0 ? '' : ', waits on ' + waits.join(', ')) +
    ', revision ' +
    String(task.revision)
  )
}

const messageLine = (message: TeamMessage): string =>
  message.from + ' -> ' + message.to + ' at ' + message.at + ': ' + message.text

const renderMessages = (value: TeamValue): ReadonlyArray<string> => {
  if (value.messages.length === 0) {
    return value.action === 'inbox' ? ['inbox: (no new messages)'] : []
  }
  if (value.action === 'send') {
    return value.messages.map((message) => 'sent to ' + message.to + ': ' + message.text)
  }
  return ['inbox:', ...value.messages.map(messageLine)]
}

const render = (value: TeamValue, agents: AgentsShape): string => {
  const roster =
    value.members.length === 0
      ? 'roster: (nobody yet)'
      : value.members.map((member) => memberLine(member, agents)).join('\n')
  const board =
    value.tasks.length === 0
      ? 'board: (nothing yet)'
      : value.tasks.map((task) => taskLine(task)).join('\n')
  const working = value.action === 'send' || value.action === 'inbox' ? [] : [roster, board]
  return [...working, ...renderMessages(value)].join('\n')
}

/** Refuses a row that would wait on itself directly or through another row. */
const cycleRefusal = (id: string, dependency: string): ToolError =>
  refuse(
    'that would make a cycle: ' +
      id +
      ' cannot wait on ' +
      dependency +
      '; remove the dependency that closes the loop',
  )

const blockers = (tasks: ReadonlyArray<TeamTask>, ids: ReadonlyArray<string>): string =>
  ids
    .map((id) => id + ' (' + (tasks.find((task) => task.id === id)?.state ?? 'missing') + ')')
    .join(', ')

const spawn = (host: TeamHost, args: TeamArgs, cwd: string, actor: TeamActor) =>
  Effect.gen(function* () {
    const refused = leadOnlyRefusal(
      actor,
      'spawn',
      'Ask your Team Lead to start the teammate with team spawn, then message it with team send.',
    )
    if (refused !== undefined) return yield* Effect.fail(refused)
    const limited = delegationRefusal(host.agents, actor.sessionId)
    if (limited !== undefined) return yield* Effect.fail(limited)
    const name = required(args.name, 'name')
    if (name instanceof ToolError) return yield* Effect.fail(name)
    if (teamRoster(host.log.events(actor.boardSession)).some((member) => member.name === name)) {
      return yield* Effect.fail(refuse(name + ' is already on the roster'))
    }
    const child = yield* host.agents
      .create({
        cwd,
        options: { route: host.route },
        seed: forkSeed(eventsOfAgent(host.agents, actor.sessionId)),
        parent: actor.sessionId,
      })
      .pipe(
        Effect.mapError(
          () => new ToolError({ code: 'execution', message: 'cannot start a teammate' }),
        ),
      )
    const member: TeamMember = { name, role: args.role ?? '', sessionId: child.id }
    yield* host.log.spawnMember(actor.boardSession, member).pipe(Effect.orDie)
    return value('spawn', [member])
  })

/** Refuses an owner that is not on the roster, so a typo does not orphan the work. */
const ownerRefusal = (
  events: ReadonlyArray<SessionEvent>,
  owner: string | undefined,
): ToolError | undefined =>
  owner === undefined || teamRoster(events).some((member) => member.name === owner)
    ? undefined
    : refuse('no teammate named ' + owner + ' on the roster; spawn it first, or leave owner off')

/** The dependencies a new row may start with: all on the board, none closing a loop. */
const newDependencies = (
  id: string,
  requested: ReadonlyArray<string>,
  tasks: ReadonlyArray<TeamTask>,
): ReadonlyArray<string> | ToolError => {
  const blockedBy = unique(requested)
  // A row that names itself is the one loop a fresh id can already close.
  const cycle = cycleIn(tasks, id, blockedBy)
  if (cycle !== undefined) return cycleRefusal(id, cycle)
  const unknown = blockedBy.find((known) => !tasks.some((task) => task.id === known))
  return unknown === undefined
    ? blockedBy
    : refuse('no task with that id: ' + unknown + '; create the task it waits on first')
}

const create = (host: TeamHost, args: TeamArgs, actor: TeamActor) =>
  Effect.gen(function* () {
    const refused = leadOnlyRefusal(
      actor,
      'create',
      'Ask your Team Lead to add the work with team create, or pick up a task the lead already assigned to you.',
    )
    if (refused !== undefined) return yield* Effect.fail(refused)
    const title = required(args.title, 'title')
    if (title instanceof ToolError) return yield* Effect.fail(title)
    const events = host.log.events(actor.boardSession)
    const tasks = teamTasks(events)
    const owner = args.owner
    const badOwner = ownerRefusal(events, owner)
    if (badOwner !== undefined) return yield* Effect.fail(badOwner)
    const id = host.log.nextId(actor.boardSession)
    const blockedBy = newDependencies(id, args.blockedBy ?? [], tasks)
    if (blockedBy instanceof ToolError) return yield* Effect.fail(blockedBy)
    const task: TeamTask = {
      id,
      title,
      state: 'pending',
      revision: 1,
      ...(owner === undefined ? {} : { owner }),
      ...(blockedBy.length === 0 ? {} : { blockedBy }),
    }
    yield* host.log.createTask(actor.boardSession, task).pipe(Effect.orDie)
    return value('create', [], [task])
  })

const get = (host: TeamHost, args: TeamArgs, actor: TeamActor) =>
  Effect.gen(function* () {
    const task = taskOf(host.log.events(actor.boardSession), String(args.id))
    if (task === undefined) {
      return yield* Effect.fail(refuse('no task with that id: ' + String(args.id)))
    }
    return value('get', [], [task])
  })

/** Refuses a teammate reaching for a row that is not its own, or for the lead's levers. */
const updateRefusal = (
  actor: TeamActor,
  args: TeamArgs,
  current: TeamTask,
): ToolError | undefined => {
  if (actor.kind === 'lead') return undefined
  if (current.owner !== actor.name) {
    return new ToolError({
      code: 'denied',
      message:
        'update ' +
        current.id +
        ' is not yours: it belongs to ' +
        (current.owner ?? 'nobody') +
        '. Only its owner or the Team Lead moves it; ask your lead to assign it to you.',
    })
  }
  if (args.owner !== undefined && args.owner !== current.owner) {
    return new ToolError({
      code: 'denied',
      message: "assigning work is the Team Lead's; ask your lead to set the owner of " + current.id,
    })
  }
  if (args.blockedBy !== undefined) {
    return new ToolError({
      code: 'denied',
      message:
        "changing what a task waits on is the Team Lead's; ask your lead to change " +
        current.id +
        ' dependencies',
    })
  }
  return undefined
}

/** The dependencies a moved row ends up with, refusing unknown ids and loops. */
const movedDependencies = (
  current: TeamTask,
  args: TeamArgs,
  tasks: ReadonlyArray<TeamTask>,
): ReadonlyArray<string> | ToolError => {
  const blockedBy = unique(args.blockedBy ?? blockedByOf(current))
  const unknown = blockedBy.find((id) => !tasks.some((task) => task.id === id))
  if (unknown !== undefined) {
    return refuse('no task with that id: ' + unknown + '; a task can only wait on one on the board')
  }
  const cycle = cycleIn(tasks, current.id, blockedBy)
  return cycle === undefined ? blockedBy : cycleRefusal(current.id, cycle)
}

/** Refuses a completion while any row it waits on is still open. */
const completionRefusal = (
  current: TeamTask,
  state: TeamTaskState,
  tasks: ReadonlyArray<TeamTask>,
  blockedBy: ReadonlyArray<string>,
): ToolError | undefined => {
  if (state !== 'done' || current.state === 'done') return undefined
  const remaining = unresolved(tasks, blockedBy)
  return remaining.length === 0
    ? undefined
    : refuse(
        'cannot complete ' +
          current.id +
          ': waiting on ' +
          blockers(tasks, remaining) +
          '; finish them first',
      )
}

/** Refuses a call that read an older revision than the row now holds. */
const revisionRefusal = (current: TeamTask, args: TeamArgs): ToolError | undefined =>
  args.revision !== undefined && args.revision !== current.revision
    ? refuse(
        'this row has moved on: it is at revision ' +
          String(current.revision) +
          ', not ' +
          String(args.revision) +
          '; read it again',
      )
    : undefined

/** The state a call moves a row to, refusing to move it after someone else did. */
const moved = (
  current: TeamTask,
  args: TeamArgs,
  tasks: ReadonlyArray<TeamTask>,
): TeamTask | ToolError => {
  const stale = revisionRefusal(current, args)
  if (stale !== undefined) return stale
  const blockedBy = movedDependencies(current, args, tasks)
  if (blockedBy instanceof ToolError) return blockedBy
  const state: TeamTaskState = args.state ?? current.state
  const refused = completionRefusal(current, state, tasks, blockedBy)
  if (refused !== undefined) return refused
  const owner = args.owner ?? current.owner
  return {
    id: current.id,
    title: current.title,
    state,
    revision: current.revision + 1,
    ...(owner === undefined ? {} : { owner }),
    ...(blockedBy.length === 0 ? {} : { blockedBy }),
  }
}

const update = (host: TeamHost, args: TeamArgs, actor: TeamActor) =>
  Effect.gen(function* () {
    const events = host.log.events(actor.boardSession)
    const current = taskOf(events, String(args.id))
    if (current === undefined) {
      return yield* Effect.fail(refuse('no task with that id: ' + String(args.id)))
    }
    const refused = updateRefusal(actor, args, current)
    if (refused !== undefined) return yield* Effect.fail(refused)
    const task = moved(current, args, teamTasks(events))
    if (task instanceof ToolError) return yield* Effect.fail(task)
    yield* host.log.updateTask(actor.boardSession, task).pipe(Effect.orDie)
    return value('update', [], [task])
  })

const send = (host: TeamHost, args: TeamArgs, actor: TeamActor) =>
  Effect.gen(function* () {
    const to = required(args.to, 'to')
    if (to instanceof ToolError) return yield* Effect.fail(to)
    const text = required(args.text, 'text')
    if (text instanceof ToolError) return yield* Effect.fail(text)
    const recipient = teamRoster(host.log.events(actor.boardSession)).find(
      (member) => member.name === to,
    )
    if (recipient === undefined) {
      return yield* Effect.fail(
        refuse(
          'no teammate named ' +
            to +
            ' on the roster; only a named teammate receives a peer message. Run team list to see the roster.',
        ),
      )
    }
    if (recipient.sessionId === actor.sessionId) {
      return yield* Effect.fail(refuse(to + ' is you; send to a different teammate'))
    }
    const peer = host.agents.get(recipient.sessionId)
    if (peer === undefined) {
      return yield* Effect.fail(
        refuse(to + ' is no longer running; only a live teammate receives a peer message'),
      )
    }
    const message: TeamMessage = {
      from: actor.name,
      fromSession: actor.sessionId,
      to: recipient.name,
      text,
      at: new Date().toISOString(),
    }
    yield* host.log.sendMessage(recipient.sessionId, message).pipe(
      Effect.mapError(
        () =>
          new ToolError({
            code: 'execution',
            message: 'cannot record the message for ' + to,
          }),
      ),
    )
    const line = { text: 'peer message from ' + actor.name + ': ' + text, source: 'user' as const }
    const delivered = peer.status === 'idle' ? peer.followup(line) : peer.steer(line)
    yield* delivered.pipe(
      Effect.mapError(
        () =>
          new ToolError({
            code: 'execution',
            message: 'the message is in ' + to + "'s inbox but its agent did not take it",
          }),
      ),
    )
    return value('send', [], [], [message])
  })

const inbox = (host: TeamHost, actor: TeamActor) =>
  Effect.gen(function* () {
    const events = host.log.events(actor.sessionId)
    const unread = unreadMessages(events)
    if (unread.length > 0) {
      yield* host.log
        .markMessagesRead(actor.sessionId, teamMessages(events).length)
        .pipe(
          Effect.mapError(
            () => new ToolError({ code: 'execution', message: 'cannot mark the inbox read' }),
          ),
        )
    }
    return value('inbox', [], [], unread)
  })

/**
 * The lead's roster and board, and the teammates' peer inbox. A teammate resolves
 * its lead from the live rosters, so every call reads and writes the same board
 * while the messages stay in the recipient's own log.
 */
export const makeTeamTool = (host: TeamHost): ToolDefinition<TeamArgs, TeamValue> => ({
  name: 'team',
  description:
    'Keeps a roster of named teammates and a shared board of work. Spawn one teammate per name (a child agent like subagent starts), then hand work out with send_message or team send. Tasks can wait on other tasks with blockedBy; update refuses to complete one while a dependency is open. Teammates may message each other, read their inbox, and move their own tasks; spawning, creating, assigning, and changing dependencies stay with the lead.',
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
          blockedBy: Schema.optionalKey(Schema.Array(Schema.String)),
          revision: Schema.Int,
        }),
      ),
      messages: Schema.Array(
        Schema.Struct({
          from: Schema.String,
          fromSession: Schema.String,
          to: Schema.String,
          text: Schema.String,
          at: Schema.String,
        }),
      ),
    }),
    render: (_args, value) => [{ type: 'text', text: render(value, host.agents) }],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const actor = teamActorOf(host.agents, context.sessionId)
      if (args.action === 'list') {
        const events = host.log.events(actor.boardSession)
        return value('list', teamRoster(events), teamTasks(events))
      }
      if (args.action === 'inbox') return yield* inbox(host, actor)
      if (args.action === 'spawn') return yield* spawn(host, args, context.cwd, actor)
      if (args.action === 'create') return yield* create(host, args, actor)
      if (args.action === 'get') return yield* get(host, args, actor)
      if (args.action === 'send') return yield* send(host, args, actor)
      return yield* update(host, args, actor)
    }),
})
