import { UiCommandSchema, UiEventSchema } from '@jozo-harness/ui-protocol'
import { type Effect, Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

/** A session as a page lists it: what the store holds, without reading its log. */
export const SessionSummarySchema = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.Number,
  /** When the log last changed, in ms; the row a page lists by recency reads this. */
  updatedAt: Schema.Number,
  /** The first thing the human typed in that session; '' when the log holds none yet. */
  title: Schema.String,
  /** Whether the reader put the session at the top of its group; absent reads as no. */
  pinned: Schema.optionalKey(Schema.Boolean),
  /** Whether the reader put the session away; absent reads as no. */
  archived: Schema.optionalKey(Schema.Boolean),
  /** Whether the log holds nothing but its header; absent reads as no. */
  empty: Schema.optionalKey(Schema.Boolean),
})

/** The wire shape of one session summary; the store's own summary carries these fields. */
export type SessionSummary = typeof SessionSummarySchema.Type

/** What the reader may do to one session from its row menu. */
export const SessionActionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('rename'), title: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('pin'), pinned: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal('archive'), archived: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal('delete') }),
])

export type SessionAction = typeof SessionActionSchema.Type

/** What a page needs before it opens anything: the list, and where to start. */
export const SessionsRpc = Rpc.make('sessions', {
  success: Schema.Struct({
    initial: Schema.String,
    items: Schema.Array(SessionSummarySchema),
    /** The sessions the server has open now: the ones a page can follow live. */
    opened: Schema.Array(Schema.String),
  }),
  error: Schema.String,
})

/**
 * Opens one session: the named one, or a new one when no id is given. A new
 * session starts in `cwd`; a resumed one keeps the directory its header recorded.
 */
export const OpenRpc = Rpc.make('open', {
  payload: Schema.Struct({
    sessionId: Schema.optionalKey(Schema.String),
    cwd: Schema.optionalKey(Schema.String),
  }),
  success: SessionSummarySchema,
  error: Schema.String,
})

/** One folder a page may start a session in, and when it last held a session. */
export const WorkspaceViewSchema = Schema.Struct({
  cwd: Schema.String,
  /** When the newest session there last changed; 0 for a folder that holds none yet. */
  lastUsedAt: Schema.Number,
})

export type WorkspaceView = typeof WorkspaceViewSchema.Type

/** The workspaces a page offers beside New session, newest use first, with the server's own. */
export const WorkspacesRpc = Rpc.make('workspaces', {
  success: Schema.Struct({
    /** Where a session opened without a workspace starts. */
    cwd: Schema.String,
    items: Schema.Array(WorkspaceViewSchema),
  }),
  error: Schema.String,
})

/** Registers one more folder a page may start a session in. */
export const AddWorkspaceRpc = Rpc.make('addWorkspace', {
  payload: Schema.Struct({ cwd: Schema.String }),
  success: Schema.Boolean,
  error: Schema.String,
})

/** Renames, pins, archives, or deletes one session. The row menu's whole vocabulary. */
export const SessionActionRpc = Rpc.make('sessionAction', {
  payload: Schema.Struct({ sessionId: Schema.String, action: SessionActionSchema }),
  success: Schema.Boolean,
  error: Schema.String,
})

/** One UI command, addressed to one session. Returns false when the core could not take it. */
export const UiCommandRpc = Rpc.make('command', {
  payload: Schema.Struct({ sessionId: Schema.String, command: UiCommandSchema }),
  success: Schema.Boolean,
})

/** Everything one session logs: history first, then live. */
export const UiEventsRpc = Rpc.make('events', {
  payload: Schema.Struct({ sessionId: Schema.String }),
  success: UiEventSchema,
  error: Schema.String,
  stream: true,
})

/** One thing the human can type at a session, ready for the composer's popup. */
export const CommandViewSchema = Schema.Struct({
  name: Schema.String,
  summary: Schema.String,
  /** A built-in command, or a skill the catalog offers under the same slash. */
  kind: Schema.Literals(['command', 'skill']),
})

export type CommandView = typeof CommandViewSchema.Type

/** The goal one session works toward, as its log last recorded it. */
export const GoalViewSchema = Schema.Struct({
  objective: Schema.String,
  phase: Schema.String,
  rounds: Schema.Number,
  maxRounds: Schema.Number,
})

/** One standing instruction and when it last came due. */
export const ScheduleViewSchema = Schema.Struct({
  id: Schema.String,
  when: Schema.String,
  prompt: Schema.String,
  /** When it last fired; 0 while it never has. */
  lastFiredAt: Schema.Number,
})

/** One background command the session started. */
export const JobViewSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  running: Schema.Boolean,
})

/** One step of the plan the session recorded with todo_write. */
export const TodoViewSchema = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(['pending', 'in_progress', 'completed']),
})

/** What one session can say about itself right now, folded from its own log and its live work. */
export const RunStateViewSchema = Schema.Struct({
  goal: Schema.Union([GoalViewSchema, Schema.Null]),
  schedules: Schema.Array(ScheduleViewSchema),
  jobs: Schema.Array(JobViewSchema),
  /** The newest plan, in the order todo_write recorded it. */
  todos: Schema.Array(TodoViewSchema),
  todoCounts: Schema.Struct({
    pending: Schema.Int,
    inProgress: Schema.Int,
    completed: Schema.Int,
  }),
  /** The skills whose instructions loaded successfully, in load order, without repeats. */
  skills: Schema.Array(Schema.String),
  /** The prompt sections of the newest system prompt; empty when the log recorded none. */
  promptSections: Schema.Array(Schema.String),
  /** What the human typed while a turn was running; it becomes the next turn. */
  queued: Schema.Array(Schema.String),
  /** The route this session asks now, `provider/model`, as the next request will. */
  model: Schema.String,
  /** The effort this session asks the provider for now; '' leaves the choice to the provider. */
  effort: Schema.String,
  /** The effort words the provider takes, as a page offers them; empty declares none. */
  efforts: Schema.Array(Schema.String),
})

export type RunStateView = typeof RunStateViewSchema.Type

/** What a page may read about the run it is talking to. */
export const SettingsViewSchema = Schema.Struct({
  model: Schema.String,
  effort: Schema.String,
  settingsPath: Schema.String,
  cwd: Schema.String,
  sessionRoot: Schema.String,
})

/** What a page reads about the run behind it; the schema is the one source. */
export type SettingsView = typeof SettingsViewSchema.Type

/** One background command, opened: what it ran, whether it still runs, what it kept. */
export const JobDetailViewSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  running: Schema.Boolean,
  output: Schema.String,
})

export type JobDetailView = typeof JobDetailViewSchema.Type

/** What one background command has kept as output. */
export const JobDetailRpc = Rpc.make('jobDetail', {
  payload: Schema.Struct({ sessionId: Schema.String, id: Schema.String }),
  success: JobDetailViewSchema,
  error: Schema.String,
})

/** Stops one background command. */
export const JobStopRpc = Rpc.make('stopJob', {
  payload: Schema.Struct({ sessionId: Schema.String, id: Schema.String }),
  success: Schema.Boolean,
  error: Schema.String,
})

/**
 * What one session can be told. The empty id asks the run itself, so the first
 * line typed on a blank page completes before any session exists.
 */
export const CommandsRpc = Rpc.make('commands', {
  payload: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.Array(CommandViewSchema),
  error: Schema.String,
})

/**
 * The workspace paths one reference word names in one session, best first. The
 * empty id asks the run itself, so the blank page completes before any session
 * exists; the walk keeps .gitignore and never reads the tree in the page.
 */
export const FilesRpc = Rpc.make('files', {
  payload: Schema.Struct({ sessionId: Schema.String, query: Schema.String }),
  success: Schema.Array(Schema.String),
  error: Schema.String,
})

/** The goal and the schedules of one session, as of now. */
export const StateRpc = Rpc.make('state', {
  payload: Schema.Struct({ sessionId: Schema.String }),
  success: RunStateViewSchema,
  error: Schema.String,
})

export const SettingsRpc = Rpc.make('settings', {
  success: SettingsViewSchema,
  error: Schema.String,
})

/** Every model the provider offers, as provider/model routes. */
export const ModelsRpc = Rpc.make('models', {
  success: Schema.Array(Schema.String),
  error: Schema.String,
})

/**
 * The route the sessions this run opens from now on start from. `remember` also
 * writes it into the settings file, so the runs after this one read it there.
 */
export const SetModelRpc = Rpc.make('setModel', {
  payload: Schema.Struct({ model: Schema.String, remember: Schema.Boolean }),
  success: Schema.Boolean,
  error: Schema.String,
})

export const UiRpcs = RpcGroup.make(
  SessionsRpc,
  OpenRpc,
  WorkspacesRpc,
  AddWorkspaceRpc,
  SessionActionRpc,
  UiCommandRpc,
  UiEventsRpc,
  CommandsRpc,
  FilesRpc,
  StateRpc,
  JobDetailRpc,
  JobStopRpc,
  SettingsRpc,
  ModelsRpc,
  SetModelRpc,
)

/**
 * Drops a phantom service requirement. `StreamChunkSchema` is annotated with
 * `Schema.Schema<StreamChunk>`, whose services erase to `unknown`, so every
 * client call of a stream RPC asks for services that do not exist. Nothing
 * here needs services at run time.
 */
export const withoutServices = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
  effect as Effect.Effect<A, E>
