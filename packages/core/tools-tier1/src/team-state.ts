import { Schema } from 'effect'
import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type SessionEvent,
  type SessionEventSchemaMap,
} from '@jozo-harness/session'

/** One named child of this session. */
export interface TeamMember {
  readonly name: string
  readonly role: string
  readonly sessionId: string
}

/** Where one piece of shared work stands. */
export type TeamTaskState = 'pending' | 'doing' | 'done' | 'blocked'

/** One row of the shared board. */
export interface TeamTask {
  readonly id: string
  readonly title: string
  readonly state: TeamTaskState
  /** Whose work it is, once someone took it. */
  readonly owner?: string
  /** The tasks that must be done before this one can be. */
  readonly blockedBy?: ReadonlyArray<string>
  /** How many times the row changed; a caller passes the one it read. */
  readonly revision: number
}

/** A message one teammate sends another, without the lead in between. */
export interface TeamMessage {
  /** The roster name of the sender. */
  readonly from: string
  /** The session that sent it, so the recipient can answer without a lookup. */
  readonly fromSession: string
  /** The roster name of the recipient. */
  readonly to: string
  readonly text: string
  /** When it was sent, as an ISO 8601 timestamp. */
  readonly at: string
}

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'team/spawned': TeamMember
    'team/task/created': { readonly task: TeamTask }
    'team/task/updated': { readonly task: TeamTask }
    'team/message': TeamMessage
    'team/message/read': { readonly count: number }
  }
}

const TeamTaskSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  state: Schema.Literals(['pending', 'doing', 'done', 'blocked']),
  owner: Schema.optionalKey(Schema.String),
  blockedBy: Schema.optionalKey(Schema.Array(Schema.String)),
  revision: Schema.Int,
})

const TeamMessageSchema = Schema.Struct({
  from: Schema.String,
  fromSession: Schema.String,
  to: Schema.String,
  text: Schema.String,
  at: Schema.String,
})

/** Schemas for the session events this module adds. */
export const teamEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  [
    'team/spawned',
    Schema.Struct({ name: Schema.String, role: Schema.String, sessionId: Schema.String }),
  ],
  ['team/task/created', Schema.Struct({ task: TeamTaskSchema })],
  ['team/task/updated', Schema.Struct({ task: TeamTaskSchema })],
  ['team/message', TeamMessageSchema],
  ['team/message/read', Schema.Struct({ count: Schema.Int })],
])

registerSessionEventSchemas(teamEventSchemas)
// The roster, the board, and the inbox are the team's bookkeeping; the model reads them from its own calls.
registerLogOnlySessionEvents([
  'team/spawned',
  'team/task/created',
  'team/task/updated',
  'team/message',
  'team/message/read',
])

/** The named children this session has, in the order they were spawned. */
export const teamRoster = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<TeamMember> =>
  events.flatMap((event) => (event.type === 'team/spawned' ? [event.data] : []))

/** The shared board, one row per task, in the order the tasks were created. */
export const teamTasks = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<TeamTask> => {
  const byId = new Map<string, TeamTask>()
  for (const event of events) {
    if (event.type !== 'team/task/created' && event.type !== 'team/task/updated') continue
    const current = byId.get(event.data.task.id)
    if (current === undefined || event.data.task.revision >= current.revision) {
      byId.set(event.data.task.id, event.data.task)
    }
  }
  return [...byId.values()]
}

/** One row of the board, or nothing when the board has no such task. */
export const taskOf = (events: ReadonlyArray<SessionEvent>, id: string): TeamTask | undefined =>
  teamTasks(events).find((task) => task.id === id)

/** The tasks this one waits on; a task created without dependencies waits on none. */
export const blockedByOf = (task: TeamTask): ReadonlyArray<string> => task.blockedBy ?? []

/** Everything said in this log's inbox, oldest first. */
export const teamMessages = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<TeamMessage> =>
  events.flatMap((event) => (event.type === 'team/message' ? [event.data] : []))

/** How many inbox messages the reader has already marked read. */
export const messagesRead = (events: ReadonlyArray<SessionEvent>): number => {
  let count = 0
  for (const event of events) {
    if (event.type === 'team/message/read') count = event.data.count
  }
  return count
}

/** The inbox messages the reader has not marked read yet. */
export const unreadMessages = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<TeamMessage> =>
  teamMessages(events).slice(messagesRead(events))
