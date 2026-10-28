import type { Attachment, Quote, UiEvent, UiSessionEvent } from '@jozo-harness/ui-protocol'
import { applyEvent, emptyConversation, type Conversation } from '@jozo-harness/ui-view'
import type {
  CommandView,
  EditableSettingsView,
  JobDetailView,
  RunStateView,
  ScheduleView,
  SessionSummary,
  SettingsView,
  WorkspaceView,
} from '../shared/rpc.ts'
import { DEFAULT_THEME, type Theme } from './theme.ts'
import { traceAfter, type TraceTurn } from './trace.ts'
import { turnsAfter, type TurnView } from './trajectory.ts'

/** What the header says about the session behind the page. */
export interface SessionInfo {
  readonly cwd: string
  readonly model: string
  readonly turns: number
  /** The git branch the workspace stands on; undefined until the page read one. */
  readonly branch?: string
}

const emptyInfo: SessionInfo = { cwd: '', model: '', turns: 0 }

/** What the right pane shows: what the session runs toward, its settings, or its turns. */
export type Pane =
  | { readonly kind: 'changes'; readonly path: string | undefined }
  | { readonly kind: 'inspect'; readonly turn: number; readonly callId: string }
  | { readonly kind: 'run' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'trajectory' }
  | { readonly kind: 'job'; readonly id: string; readonly detail: JobDetailView | undefined }

/** What the browser shows: the conversation, the socket, the draft, and the sessions. */
export interface WebState {
  readonly conversation: Conversation
  readonly connected: boolean
  readonly draft: string
  /** Passages selected from earlier turns, to travel with the next message. */
  readonly quotes: ReadonlyArray<Quote>
  /** Files uploaded for the next message, in the order the composer shows them. */
  readonly attachments: ReadonlyArray<Attachment>
  /** The conversation text the reader has selected, waiting to become a quote. */
  readonly selection: string
  readonly info: SessionInfo
  /** Every session the store holds, newest first, as the sidebar lists them. */
  readonly sessions: ReadonlyArray<SessionSummary>
  /** The session being read; '' until the page has opened one. */
  readonly sessionId: string
  /** The sessions the server has open, which stay listed even when empty. */
  readonly opened: ReadonlyArray<string>
  /** Why the last move failed; shown until the page moves again. */
  readonly problem: string
  /** Which of the ways a page may be lit the reader chose. */
  readonly theme: Theme
  /** What the server says about this run; undefined until the page has read it. */
  readonly settings: SettingsView | undefined
  /** The values the settings pane may edit; undefined until the pane asked. */
  readonly editable: EditableSettingsView | undefined
  /** Why the last settings read or save failed; '' when nothing did. */
  readonly settingsProblem: string
  /** The provider's models, once the reader asked for them; undefined while nobody has. */
  readonly models: ReadonlyArray<string> | undefined
  /** What this session can be told, once the composer asked; undefined while nobody has. */
  readonly commands: ReadonlyArray<CommandView> | undefined
  /** The workspace paths the last reference word named; undefined until one asked. */
  readonly files: FileMatches | undefined
  /** The folders a new session may start in; undefined until the page asked. */
  readonly workspaces: Workspaces | undefined
  /** Which surface the right pane shows; undefined leaves the tab strip alone and the body empty. */
  readonly pane: Pane | undefined
  /** Every turn this session ran, oldest first, as the log recorded it. */
  readonly turns: ReadonlyArray<TurnView>
  /** What the session says it works toward; undefined until the page has asked. */
  readonly run: RunStateView | undefined
  /** Every turn this session ran, folded one event at a time down to its steps and calls. */
  readonly trace: ReadonlyArray<TraceTurn>
  /** The pages removed from this session here, which the log still names. */
  readonly deletedPages: ReadonlyArray<string>
}

/** The folders a new session may start in, and the one it starts in by default. */
export interface Workspaces {
  readonly cwd: string
  readonly items: ReadonlyArray<WorkspaceView>
}

/** One answer to a reference query: the paths, and the session and word that asked. */
export interface FileMatches {
  readonly sessionId: string
  readonly query: string
  readonly paths: ReadonlyArray<string>
}

export const initialState: WebState = {
  conversation: emptyConversation,
  connected: false,
  draft: '',
  quotes: [],
  attachments: [],
  selection: '',
  info: emptyInfo,
  sessions: [],
  sessionId: '',
  opened: [],
  problem: '',
  theme: DEFAULT_THEME,
  settings: undefined,
  editable: undefined,
  settingsProblem: '',
  models: undefined,
  commands: undefined,
  files: undefined,
  workspaces: undefined,
  pane: { kind: 'run' },
  turns: [],
  run: undefined,
  trace: [],
  deletedPages: [],
}

export const withConnection = (state: WebState, connected: boolean): WebState => ({
  ...state,
  connected,
})

export const withDraft = (state: WebState, draft: string): WebState => ({ ...state, draft })

/** Keeps the passages the next message will quote, newest last. */
export const withQuotes = (state: WebState, quotes: ReadonlyArray<Quote>): WebState => ({
  ...state,
  quotes,
})

/** Keeps the files the next message carries, newest last. */
export const withAttachments = (
  state: WebState,
  attachments: ReadonlyArray<Attachment>,
): WebState => ({ ...state, attachments })

/** Remembers the conversation text the reader holds selected, so a button can quote it. */
export const withSelection = (state: WebState, selection: string): WebState => ({
  ...state,
  selection,
})

export const withSessions = (state: WebState, items: ReadonlyArray<SessionSummary>): WebState => ({
  ...state,
  sessions: items,
})

/** The sessions the server has open now: the sidebar keeps an empty one of these visible. */
export const withOpened = (state: WebState, opened: ReadonlyArray<string>): WebState => ({
  ...state,
  opened,
})

export const withProblem = (state: WebState, problem: string): WebState => ({ ...state, problem })

/** A page the server no longer holds, so the run pane does not offer it again. */
export const withDeletedPage = (state: WebState, page: string): WebState =>
  state.deletedPages.includes(page)
    ? state
    : { ...state, deletedPages: [...state.deletedPages, page] }

export const withTheme = (state: WebState, theme: Theme): WebState => ({ ...state, theme })

export const withSettings = (state: WebState, settings: SettingsView): WebState => ({
  ...state,
  settings,
})

/** The settings the page may edit, as the server last resolved them. */
export const withEditable = (state: WebState, editable: EditableSettingsView): WebState => ({
  ...state,
  editable,
})

export const withSettingsProblem = (state: WebState, problem: string): WebState => ({
  ...state,
  settingsProblem: problem,
})

export const withModels = (state: WebState, models: ReadonlyArray<string>): WebState => ({
  ...state,
  models,
})

export const withCommands = (state: WebState, commands: ReadonlyArray<CommandView>): WebState => ({
  ...state,
  commands,
})

/** The folders a new session may start in, as the server last listed them. */
export const withWorkspaces = (state: WebState, workspaces: Workspaces): WebState => ({
  ...state,
  workspaces,
})

/** The paths one reference word named; a late answer is tagged, so the page can tell whose it is. */
export const withFiles = (state: WebState, files: FileMatches): WebState => ({
  ...state,
  files,
})

export const withPane = (state: WebState, pane: Pane | undefined): WebState => ({
  ...state,
  pane,
})

/** Replaces the schedules of the run on screen, after a page created, stopped, or removed one. */
export const withRunSchedules = (
  state: WebState,
  schedules: ReadonlyArray<ScheduleView>,
): WebState => (state.run === undefined ? state : { ...state, run: { ...state.run, schedules } })

export const withRun = (state: WebState, run: RunStateView): WebState => ({ ...state, run })

/** The branch the workspace stands on, as the server read it when the session opened. */
export const withBranch = (state: WebState, branch: string): WebState => ({
  ...state,
  info: { ...state.info, branch },
})

/**
 * Reads no session: the blank page New session moves to. The conversation and
 * the run state start over, and the first line typed here opens the session
 * that receives it.
 */
export const withBlank = (state: WebState): WebState => ({
  ...state,
  sessionId: '',
  conversation: emptyConversation,
  info: emptyInfo,
  problem: '',
  quotes: [],
  attachments: [],
  selection: '',
  run: undefined,
  // The lists belonged to the session left behind; the next one reads its own on demand.
  commands: undefined,
  files: undefined,
  turns: [],
  trace: [],
})

/**
 * Reads one session: the conversation starts over because another log does, and
 * a session the store did not list (one just created) joins the sidebar.
 */
export const withSession = (state: WebState, summary: SessionSummary): WebState => {
  const known = state.sessions.some((item) => item.id === summary.id)
  return {
    ...state,
    sessions: known ? state.sessions : [...state.sessions, summary],
    sessionId: summary.id,
    conversation: emptyConversation,
    info: emptyInfo,
    // A move to another session starts the page over. Opening the session it
    // already shows again is no move: the line about what just went wrong stays,
    // which is what a page that reopens a refused session has to say for itself.
    problem: state.sessionId === summary.id ? state.problem : '',
    // A passage selected in another session names nothing here, and neither
    // does a file uploaded for the message it was composing.
    quotes: [],
    attachments: [],
    selection: '',
    run: undefined,
    commands: state.sessionId === summary.id ? state.commands : undefined,
    files: state.sessionId === summary.id ? state.files : undefined,
    turns: [],
    trace: [],
    deletedPages: [],
  }
}

/** The event bodies arrive as unknown; a header shows nothing it could not read. */
const fieldOf = (data: unknown, key: string): unknown =>
  typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined

const withCwd = (info: SessionInfo, data: unknown): SessionInfo => {
  const cwd = fieldOf(data, 'cwd')
  return typeof cwd === 'string' ? { ...info, cwd } : info
}

const withModel = (info: SessionInfo, data: unknown): SessionInfo => {
  const provider = fieldOf(data, 'provider')
  const model = fieldOf(data, 'model')
  return typeof provider === 'string' && typeof model === 'string'
    ? { ...info, model: provider + '/' + model }
    : info
}

const withTurn = (info: SessionInfo, data: unknown): SessionInfo => {
  const turn = fieldOf(data, 'turn')
  return typeof turn === 'number' ? { ...info, turns: Math.max(info.turns, turn) } : info
}

/** The events the header reads, by name: one lookup instead of a chain of tests. */
const INFO_READERS: Readonly<Record<string, (info: SessionInfo, data: unknown) => SessionInfo>> = {
  'session/header': withCwd,
  'session/cwd/changed': withCwd,
  'request/header': withModel,
  'turn/start': withTurn,
}

const infoAfter = (info: SessionInfo, event: UiSessionEvent): SessionInfo => {
  const read = INFO_READERS[event.type]
  return read === undefined ? info : read(info, event.data)
}

/**
 * True when the log moved in a way that may have changed what the session can be
 * told: a turn ended, or the run handed the model a skill catalog it had not read.
 * The composer reads the list again rather than keeping what it cached.
 */
const commandsStale = (event: UiSessionEvent): boolean =>
  event.type === 'turn/end' ||
  (event.type === 'user/message' && fieldOf(event.data, 'source') === 'skill-catalog')

export const applyUiEvent = (state: WebState, event: UiEvent): WebState => {
  // The transport may replay the boundary event: only a seq the page has not seen counts.
  const fresh = event.kind === 'session' && event.event.seq > state.conversation.lastSeq
  return {
    ...state,
    commands:
      event.kind === 'session' && fresh && commandsStale(event.event) ? undefined : state.commands,
    info: event.kind === 'session' ? infoAfter(state.info, event.event) : state.info,
    turns: fresh ? turnsAfter(state.turns, event.event) : state.turns,
    trace: fresh ? traceAfter(state.trace, event.event) : state.trace,
    conversation: applyEvent(state.conversation, event),
  }
}
