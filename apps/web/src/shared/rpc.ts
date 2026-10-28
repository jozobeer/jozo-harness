import { AttachmentSchema, UiCommandSchema, UiEventSchema } from '@jozo-harness/ui-protocol'
import { type Effect, Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

/** One row of the composition as the plugin route lists it. */
export interface PluginRowView {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  /** True when this run was built from the row; a row installed on the page waits for the next start. */
  readonly running: boolean
}

/** One optional bundle the page may install, as the build's catalog lists it. */
export interface PluginCatalogView {
  /** The row id the install writes. */
  readonly id: string
  readonly name: string
  readonly summary: string
  /** True when the plugin needs config an id-and-name row would not carry. */
  readonly needsConfig: boolean
  /** True when a row already names it, so there is nothing to install. */
  readonly installed: boolean
}

/** A row this run tried to wire and could not, with the reason it gave. */
export interface PluginFailureView {
  readonly id: string
  readonly name: string
  readonly reason: string
}

/** What the plugin route answers: the run's rows, the opt-in catalog, and the failed wirings. */
export interface PluginsView {
  readonly rows: ReadonlyArray<PluginRowView>
  readonly catalog: ReadonlyArray<PluginCatalogView>
  readonly failures: ReadonlyArray<PluginFailureView>
}

/** What the plugin pane may ask the server to do. */
export type PluginChangeRequest =
  | { readonly action: 'set-enabled'; readonly id: string; readonly enabled: boolean }
  | { readonly action: 'install'; readonly id: string; readonly name: string }
  | { readonly action: 'retry'; readonly id: string }

/** A session as a page lists it: what the store holds, without reading its log. */
export const SessionSummarySchema = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.Number,
  /** When the log last changed, in ms; the row a page lists by recency reads this. */
  updatedAt: Schema.Number,
  /** The name the log carries, model-written or the first message; '' when nothing named it. */
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

/**
 * The git branch the session's workspace stands on: null when it names none
 * (not a git workspace, detached HEAD, or no git to ask).
 */
export const BranchRpc = Rpc.make('branch', {
  payload: Schema.Struct({ sessionId: Schema.String }),
  success: Schema.NullOr(Schema.String),
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

/** One folder as the Add workspace dialog browses it: where it is, and the folders inside it. */
export const DirectoryViewSchema = Schema.Struct({
  path: Schema.String,
  /** The folder above it, or null at the filesystem root. */
  parent: Schema.NullOr(Schema.String),
  /** The child folders as full paths, sorted by name. */
  items: Schema.Array(Schema.String),
})

export type DirectoryView = typeof DirectoryViewSchema.Type

/** Reads one folder for the Add workspace dialog; '' starts at the run's own folder. */
export const BrowseDirectoriesRpc = Rpc.make('browseDirectories', {
  payload: Schema.Struct({ path: Schema.String }),
  success: DirectoryViewSchema,
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

/**
 * Tells every page that the store changed: a session was opened, closed, or its
 * row changed by another device. The page reads the list itself; the signal only
 * says the copy it holds is old.
 */
export const StoreChangedRpc = Rpc.make('storeChanged', {
  success: Schema.Number,
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
  /** The short title; an older schedule without one shows the prompt's first line. */
  title: Schema.String,
  prompt: Schema.String,
  /** When it last fired; 0 while it never has. */
  lastFiredAt: Schema.Number,
  /** True while the human stopped it; absent reads as no. */
  paused: Schema.optionalKey(Schema.Boolean),
})

export type ScheduleView = typeof ScheduleViewSchema.Type

/**
 * What a page may ask a new schedule to do. The model's schedule tool takes the
 * same fields and is refused by the same checks, so either side creates what the
 * other lists.
 */
export const ScheduleCreateSchema = Schema.Struct({
  sessionId: Schema.String,
  prompt: Schema.String,
  title: Schema.optionalKey(Schema.String),
  every: Schema.optionalKey(Schema.Int),
  daily: Schema.optionalKey(Schema.String),
  weekly: Schema.optionalKey(
    Schema.Struct({ weekdays: Schema.Array(Schema.Int), time: Schema.String }),
  ),
  cron: Schema.optionalKey(Schema.String),
  /** The IANA zone a daily, weekly, or cron wall clock reads. */
  timeZone: Schema.optionalKey(Schema.String),
  /** One absolute instant as ISO 8601 with an offset. */
  at: Schema.optionalKey(Schema.String),
  /** One run this many seconds from now. */
  after: Schema.optionalKey(Schema.Int),
})

/** Creates one schedule in the host store and answers with the session's standing ones. */
export const ScheduleCreateRpc = Rpc.make('scheduleCreate', {
  payload: ScheduleCreateSchema,
  success: Schema.Array(ScheduleViewSchema),
  error: Schema.String,
})

/** Stops or restarts one schedule without forgetting it. */
export const SchedulePauseRpc = Rpc.make('schedulePause', {
  payload: Schema.Struct({
    sessionId: Schema.String,
    id: Schema.String,
    paused: Schema.Boolean,
  }),
  success: Schema.Array(ScheduleViewSchema),
  error: Schema.String,
})

/** Removes one schedule from the host store. */
export const ScheduleDeleteRpc = Rpc.make('scheduleDelete', {
  payload: Schema.Struct({ sessionId: Schema.String, id: Schema.String }),
  success: Schema.Array(ScheduleViewSchema),
  error: Schema.String,
})

/** One background command the session started. */
export const JobViewSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  running: Schema.Boolean,
  /** When the job began, in ms; the page reads the elapsed time from it. */
  startedAt: Schema.Number,
  /** When the job stopped, in ms; absent while it still runs. */
  endedAt: Schema.optionalKey(Schema.Number),
  /** The end of the newest line the job produced, for a row that stays one row. */
  tail: Schema.String,
})

/** One child agent the session started, as the core holds it now. */
export const SubagentViewSchema = Schema.Struct({
  id: Schema.String,
  /** idle | running | cancelling | disposed, as the child reports now. */
  status: Schema.String,
  /** When the child session began, in ms; the page reads the elapsed time from it. */
  startedAt: Schema.Number,
  /** The agent preset the child runs under, so its row names the role, not just an id. */
  preset: Schema.optionalKey(Schema.String),
  /** When the child stopped, in ms; absent while it still works. */
  endedAt: Schema.optionalKey(Schema.Number),
})

/** One step of the plan the session recorded with todo_write. */
export const TodoViewSchema = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(['pending', 'in_progress', 'completed']),
})

/**
 * The usage a page draws, already rounded from the log, with the shares its bar
 * and dial need. A number the log cannot state is absent, so it never reads as zero.
 */
export const UsageViewSchema = Schema.Struct({
  total: Schema.String,
  input: Schema.String,
  output: Schema.String,
  turns: Schema.Int,
  cache: Schema.optionalKey(Schema.String),
  speed: Schema.optionalKey(Schema.Struct({ text: Schema.String, value: Schema.Number })),
  context: Schema.optionalKey(
    Schema.Struct({
      used: Schema.String,
      window: Schema.String,
      left: Schema.String,
      share: Schema.Number,
      fire: Schema.Number,
    }),
  ),
})

/** What one session can say about itself right now, folded from its own log and its live work. */
export const RunStateViewSchema = Schema.Struct({
  goal: Schema.Union([GoalViewSchema, Schema.Null]),
  schedules: Schema.Array(ScheduleViewSchema),
  jobs: Schema.Array(JobViewSchema),
  /** The children this session started, as the core holds them right now. */
  subagents: Schema.Array(SubagentViewSchema),
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
  /** What the human sent into the running turn's next step; it does not become a turn. */
  steering: Schema.Array(Schema.String),
  /** The route this session asks now, `provider/model`, as the next request will. */
  model: Schema.String,
  /** The effort this session asks the provider for now; '' leaves the choice to the provider. */
  effort: Schema.String,
  /** The effort words the provider takes, as a page offers them; empty declares none. */
  efforts: Schema.Array(Schema.String),
  /** The boundary the next tool call runs under, as this session currently holds it. */
  permission: Schema.optionalKey(
    Schema.Literals(['read-only', 'workspace-write', 'danger-full-access']),
  ),
  /** Tokens, speed and context, as the Run pane and the composer's ring draw them. */
  usage: Schema.optionalKey(UsageViewSchema),
})

export type RunStateView = typeof RunStateViewSchema.Type

/** What a page may read about the run it is talking to. */
export const SettingsViewSchema = Schema.Struct({
  model: Schema.String,
  effort: Schema.String,
  /** The effort words the provider takes, as a page offers them; empty declares none. */
  efforts: Schema.Array(Schema.String),
  settingsPath: Schema.String,
  cwd: Schema.String,
  sessionRoot: Schema.String,
})

/** What a page reads about the run behind it; the schema is the one source. */
export type SettingsView = typeof SettingsViewSchema.Type

/** The web_search providers the settings file accepts. */
export const SearchProviderSchema = Schema.Literals(['brave', 'deepseek', 'exa', 'perplexity'])

export type SearchProvider = typeof SearchProviderSchema.Type

/**
 * One value the settings pane may edit, with where it came from. The value is
 * always safe to show: a secret is represented by its reference and whether it
 * is present, never by the secret itself.
 */
export const EditableLimitSchema = Schema.Struct({
  value: Schema.Int,
  /** The file or row the value in effect came from. */
  source: Schema.String,
})

export const EditableSearchSchema = Schema.Struct({
  provider: Schema.optionalKey(SearchProviderSchema),
  /** The variable the chosen provider reads, for a page that says what is missing. */
  keyName: Schema.String,
  keyPresent: Schema.Boolean,
  source: Schema.String,
})

export const EditableKeyRefSchema = Schema.Struct({
  /** The reference name in the credentials store; '' when the row names none. */
  ref: Schema.String,
  /** Whether the store holds the reference; the value itself never leaves the server. */
  present: Schema.Boolean,
  source: Schema.String,
})

export const DelegateToolViewSchema = Schema.Struct({
  name: Schema.String,
  argv: Schema.Array(Schema.String),
})

export type DelegateToolView = typeof DelegateToolViewSchema.Type

/** The run's editable settings, resolved the way a run resolves them. */
export const EditableSettingsViewSchema = Schema.Struct({
  search: EditableSearchSchema,
  apiKeyRef: EditableKeyRefSchema,
  bashTimeoutMs: EditableLimitSchema,
  maxParallelToolCalls: EditableLimitSchema,
  subagentDepth: EditableLimitSchema,
  delegateTools: Schema.Array(DelegateToolViewSchema),
})

export type EditableSettingsView = typeof EditableSettingsViewSchema.Type

/** What a page asks to write: everything it can edit, with '' clearing a value. */
export const RunSettingsInputSchema = Schema.Struct({
  /** One of the search providers, or '' to leave the choice to the key present. */
  search: Schema.String,
  /** The credentials reference the llm row names, or '' for none. */
  apiKeyRef: Schema.String,
  bashTimeoutMs: Schema.Int,
  maxParallelToolCalls: Schema.Int,
  subagentDepth: Schema.Int,
  delegateTools: Schema.Array(DelegateToolViewSchema),
})

export type RunSettingsInput = typeof RunSettingsInputSchema.Type

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

/** Stops one child agent this session started, without disposing of it. */
export const SubagentStopRpc = Rpc.make('stopSubagent', {
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

/** One entry of the workspace tree: a folder to open, or a file to hand on. */
export const WorkspaceEntrySchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(['directory', 'file']),
})

/**
 * One folder of the workspace tree. The page asks for one folder at a time and
 * keeps what it opened, so a deep tree costs one listing per opened folder.
 */
export type WorkspaceEntry = typeof WorkspaceEntrySchema.Type

export const WorkspaceDirectorySchema = Schema.Struct({
  /** The folder relative to the workspace root; '' is the root itself. */
  path: Schema.String,
  /** Folders first, then files, each by name. */
  entries: Schema.Array(WorkspaceEntrySchema),
  /** True when the folder holds more entries than one listing carries. */
  truncated: Schema.Boolean,
})

export type WorkspaceDirectory = typeof WorkspaceDirectorySchema.Type

/**
 * One folder of the session's workspace, read when the tree opens it. The blank
 * id asks the run itself, so the tree opens before any session exists.
 */
export const WorkspaceDirectoryRpc = Rpc.make('workspaceDirectory', {
  payload: Schema.Struct({ sessionId: Schema.String, path: Schema.String }),
  success: WorkspaceDirectorySchema,
  error: Schema.String,
})

/**
 * What one workspace file shows as in the right pane: its text, an image or a
 * PDF as base64, or the reason it has no preview. The server reads the file
 * through the same gate as the tree and never writes to it.
 */
export const WorkspacePreviewSchema = Schema.Struct({
  /** The path relative to the workspace root, as the tree names it. */
  path: Schema.String,
  kind: Schema.Literals(['text', 'markdown', 'image', 'pdf', 'html', 'unsupported']),
  mediaType: Schema.String,
  /** The file's size on disk, so a shortened preview can say what it left out. */
  size: Schema.Number,
  /** The head of a text file, decoded as UTF-8. */
  text: Schema.optionalKey(Schema.String),
  /** The bytes of an image or a PDF, base64 encoded for JSON. */
  data: Schema.optionalKey(Schema.String),
  /** True when `text` is only the head of a larger file. */
  truncated: Schema.Boolean,
  /** Why a file has no preview, shown as it is. */
  reason: Schema.optionalKey(Schema.String),
})

export type WorkspacePreview = typeof WorkspacePreviewSchema.Type

/**
 * One file of the session's workspace, read when the reader picks it in the
 * tree or names its path. The blank id asks the run itself, as the tree does.
 */
export const WorkspaceFileRpc = Rpc.make('workspaceFile', {
  payload: Schema.Struct({ sessionId: Schema.String, path: Schema.String }),
  success: WorkspacePreviewSchema,
  error: Schema.String,
})

/**
 * Keeps one file the composer attached under the hash of its bytes. The page
 * sends the bytes; the server validates the type and size and returns the
 * reference the message carries.
 */
export const AttachRpc = Rpc.make('attach', {
  payload: Schema.Struct({
    name: Schema.String,
    mediaType: Schema.String,
    data: Schema.String,
  }),
  success: AttachmentSchema,
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

/** The effort the sessions this run opens from now on start from. */
export const SetEffortRpc = Rpc.make('setEffort', {
  payload: Schema.Struct({ effort: Schema.String }),
  success: Schema.Boolean,
  error: Schema.String,
})

/** Every editable value, with where it came from; secrets appear only as a reference. */
export const RunSettingsRpc = Rpc.make('runSettings', {
  success: EditableSettingsViewSchema,
  error: Schema.String,
})

/** Validates and writes every editable value through the settings file in one go. */
export const SaveRunSettingsRpc = Rpc.make('saveRunSettings', {
  payload: RunSettingsInputSchema,
  success: EditableSettingsViewSchema,
  error: Schema.String,
})

/** One app a session's workspace can be handed to on the machine running the server. */
export const OpenAppSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
})

export type OpenAppView = typeof OpenAppSchema.Type

/** The detected apps, or the reason the machine has none. */
export const OpenAppsViewSchema = Schema.Struct({
  apps: Schema.Array(OpenAppSchema),
  reason: Schema.optionalKey(Schema.String),
})

export type OpenAppsView = typeof OpenAppsViewSchema.Type

/** Reads the apps this machine can open a workspace with. No app is an answer, not a failure. */
export const OpenAppsRpc = Rpc.make('openApps', {
  success: OpenAppsViewSchema,
  error: Schema.String,
})

/**
 * Opens one path inside the session's workspace with one detected app. The path
 * is relative to the workspace; '' is the workspace itself. This is the reader's
 * own action on their machine, so it starts no turn.
 */
export const OpenInAppRpc = Rpc.make('openInApp', {
  payload: Schema.Struct({
    sessionId: Schema.String,
    app: Schema.String,
    path: Schema.String,
  }),
  success: Schema.Boolean,
  error: Schema.String,
})

export const UiRpcs = RpcGroup.make(
  SessionsRpc,
  OpenRpc,
  BranchRpc,
  WorkspacesRpc,
  BrowseDirectoriesRpc,
  AddWorkspaceRpc,
  SessionActionRpc,
  UiCommandRpc,
  UiEventsRpc,
  StoreChangedRpc,
  CommandsRpc,
  FilesRpc,
  WorkspaceDirectoryRpc,
  WorkspaceFileRpc,
  OpenAppsRpc,
  OpenInAppRpc,
  AttachRpc,
  StateRpc,
  ScheduleCreateRpc,
  SchedulePauseRpc,
  ScheduleDeleteRpc,
  JobDetailRpc,
  JobStopRpc,
  SubagentStopRpc,
  SettingsRpc,
  ModelsRpc,
  SetModelRpc,
  SetEffortRpc,
  RunSettingsRpc,
  SaveRunSettingsRpc,
)

/**
 * Drops a phantom service requirement. `StreamChunkSchema` is annotated with
 * `Schema.Schema<StreamChunk>`, whose services erase to `unknown`, so every
 * client call of a stream RPC asks for services that do not exist. Nothing
 * here needs services at run time.
 */
export const withoutServices = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
  effect as Effect.Effect<A, E>
