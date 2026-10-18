import type { UiEvent, UiSessionEvent } from '@jozo-harness/ui-protocol'
import { applyEvent, emptyConversation, type Conversation } from '@jozo-harness/ui-view'
import type {
  CommandView,
  JobDetailView,
  RunStateView,
  SessionSummary,
  SettingsView,
} from '../shared/rpc.ts'
import { DEFAULT_THEME, type Theme } from './theme.ts'
import { traceAfter, type TraceTurn } from './trace.ts'
import { turnsAfter, type TurnView } from './trajectory.ts'

/** What the header says about the session behind the page. */
export interface SessionInfo {
  readonly cwd: string
  readonly model: string
  readonly turns: number
}

const emptyInfo: SessionInfo = { cwd: '', model: '', turns: 0 }

/** What the right pane shows: what the session runs toward, its settings, its turns, or one job. */
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
  /** The provider's models, once the reader asked for them; undefined while nobody has. */
  readonly models: ReadonlyArray<string> | undefined
  /** What this session can be told, once the composer asked; undefined while nobody has. */
  readonly commands: ReadonlyArray<CommandView> | undefined
  /** Which surface the right pane shows; undefined leaves the tab strip alone and the body empty. */
  readonly pane: Pane | undefined
  /** Every turn this session ran, oldest first, as the log recorded it. */
  readonly turns: ReadonlyArray<TurnView>
  /** What the session says it works toward; undefined until the page has asked. */
  readonly run: RunStateView | undefined
  /** Every turn this session ran, folded one event at a time down to its steps and calls. */
  readonly trace: ReadonlyArray<TraceTurn>
}

export const initialState: WebState = {
  conversation: emptyConversation,
  connected: false,
  draft: '',
  info: emptyInfo,
  sessions: [],
  sessionId: '',
  opened: [],
  problem: '',
  theme: DEFAULT_THEME,
  settings: undefined,
  models: undefined,
  commands: undefined,
  pane: { kind: 'run' },
  turns: [],
  run: undefined,
  trace: [],
}

export const withConnection = (state: WebState, connected: boolean): WebState => ({
  ...state,
  connected,
})

export const withDraft = (state: WebState, draft: string): WebState => ({ ...state, draft })

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

export const withTheme = (state: WebState, theme: Theme): WebState => ({ ...state, theme })

export const withSettings = (state: WebState, settings: SettingsView): WebState => ({
  ...state,
  settings,
})

export const withModels = (state: WebState, models: ReadonlyArray<string>): WebState => ({
  ...state,
  models,
})

export const withCommands = (state: WebState, commands: ReadonlyArray<CommandView>): WebState => ({
  ...state,
  commands,
})

export const withPane = (state: WebState, pane: Pane | undefined): WebState => ({
  ...state,
  pane,
})

export const withRun = (state: WebState, run: RunStateView): WebState => ({ ...state, run })

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
  run: undefined,
  // The list belonged to the session left behind; the next one reads its own on demand.
  commands: undefined,
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
    run: undefined,
    commands: state.sessionId === summary.id ? state.commands : undefined,
    turns: [],
    trace: [],
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

export const applyUiEvent = (state: WebState, event: UiEvent): WebState => {
  // The transport may replay the boundary event: only a seq the page has not seen counts.
  const fresh = event.kind === 'session' && event.event.seq > state.conversation.lastSeq
  return {
    ...state,
    info: event.kind === 'session' ? infoAfter(state.info, event.event) : state.info,
    turns: fresh ? turnsAfter(state.turns, event.event) : state.turns,
    trace: fresh ? traceAfter(state.trace, event.event) : state.trace,
    conversation: applyEvent(state.conversation, event),
  }
}
