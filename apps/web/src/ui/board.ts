import type { UiEvent } from '@jozo-harness/ui-protocol'
import { applyEvent, emptyConversation, type Conversation } from '@jozo-harness/ui-view'
import type { SessionSummary } from '../shared/rpc.ts'
import { toolsOf, traceAfter, type TraceTurn } from './trace.ts'

type ApprovalRequested = NonNullable<Conversation['approval']>
type AskRequested = NonNullable<Conversation['ask']>

/** One session the page follows live, folded the way the conversation folds it. */
export interface Watched {
  readonly conversation: Conversation
  readonly trace: ReadonlyArray<TraceTurn>
}

export const emptyWatched: Watched = { conversation: emptyConversation, trace: [] }

/** Folds one event; the transport may replay the boundary event, so only a fresh seq counts. */
export const watchedAfter = (watched: Watched, event: UiEvent): Watched => {
  const fresh = event.kind === 'session' && event.event.seq > watched.conversation.lastSeq
  return {
    conversation: applyEvent(watched.conversation, event),
    trace: fresh ? traceAfter(watched.trace, event.event) : watched.trace,
  }
}

/** What a session needs from the human: an approval, a question, or nothing. */
export type Waiting =
  | { readonly kind: 'approval'; readonly request: ApprovalRequested }
  | { readonly kind: 'ask'; readonly request: AskRequested }

export type BoardStatus = 'waiting' | 'running' | 'idle' | 'closed'

/** One row of the board: a session, how it stands, and what it is doing or did. */
export interface BoardEntry {
  readonly summary: SessionSummary
  readonly status: BoardStatus
  readonly waiting: Waiting | undefined
  /** When the work the row reports began: the open turn's start, else the last activity. */
  readonly since: number
  readonly turns: number
  readonly calls: number
  /** The tool running now, as one line; '' when none runs. */
  readonly doing: string
  /** The first line of the last answer; '' before there is one. */
  readonly said: string
}

const waitingOf = (conversation: Conversation): Waiting | undefined => {
  if (conversation.approval !== undefined) {
    return { kind: 'approval', request: conversation.approval }
  }
  return conversation.ask === undefined ? undefined : { kind: 'ask', request: conversation.ask }
}

const statusOf = (watched: Watched, waiting: Waiting | undefined): BoardStatus => {
  if (waiting !== undefined) return 'waiting'
  return watched.conversation.running ? 'running' : 'idle'
}

const closedEntry = (summary: SessionSummary): BoardEntry => ({
  summary,
  status: 'closed',
  waiting: undefined,
  since: summary.updatedAt,
  turns: 0,
  calls: 0,
  doing: '',
  said: '',
})

/** What the last turn says: when its work began or ended, its calls, what runs, what it said. */
const lastTurnFacts = (last: TraceTurn | undefined) => {
  if (last === undefined) return { since: undefined, calls: 0, doing: '', said: '' }
  const tools = toolsOf(last)
  const running = tools.findLast((tool) => tool.status === 'running')
  return {
    since: last.endedAt ?? last.startedAt,
    calls: tools.length,
    doing: running === undefined ? '' : running.name + ' ' + running.summary,
    said: last.answer.split('\n')[0] ?? '',
  }
}

/** The row for one session; a session nobody follows reads as closed. */
export const entryOf = (summary: SessionSummary, watched: Watched | undefined): BoardEntry => {
  if (watched === undefined) return closedEntry(summary)
  const facts = lastTurnFacts(watched.trace[watched.trace.length - 1])
  const waiting = waitingOf(watched.conversation)
  return {
    ...facts,
    summary,
    status: statusOf(watched, waiting),
    waiting,
    since: facts.since ?? summary.updatedAt,
    turns: watched.trace.length,
  }
}

/** The board in the order a reader acts on it: what waits on them, what runs, the rest. */
export interface Board {
  readonly waiting: ReadonlyArray<BoardEntry>
  readonly running: ReadonlyArray<BoardEntry>
  readonly rest: ReadonlyArray<BoardEntry>
}

const newestFirst = (a: BoardEntry, b: BoardEntry): number => b.since - a.since

/** What the reader pinned stays at the top of its group; the rest keeps recency. */
const pinnedFirst = (a: BoardEntry, b: BoardEntry): number =>
  Number(b.summary.pinned === true) - Number(a.summary.pinned === true)

export const boardOf = (
  sessions: ReadonlyArray<SessionSummary>,
  watched: ReadonlyMap<string, Watched>,
): Board => {
  const entries = sessions.map((summary) => entryOf(summary, watched.get(summary.id)))
  const having = (...statuses: ReadonlyArray<BoardStatus>) =>
    entries
      .filter((entry) => statuses.includes(entry.status))
      .toSorted((left, right) => pinnedFirst(left, right) || newestFirst(left, right))
  return {
    waiting: having('waiting'),
    running: having('running'),
    rest: having('idle', 'closed'),
  }
}

/** How many rows of one folder Recent shows before the reader asks for the rest. */
export const RECENT_PAGE = 5

/** One workspace's slice of Recent: its sessions, and when the folder last changed. */
export interface RecentGroup {
  readonly cwd: string
  /** The newest update among the folder's sessions, which orders the folders. */
  readonly updatedAt: number
  readonly entries: ReadonlyArray<BoardEntry>
}

/** The folders by their latest update, with a stable tie so the rail does not shuffle. */
const folderFirst = (left: RecentGroup, right: RecentGroup): number =>
  right.updatedAt - left.updatedAt || left.cwd.localeCompare(right.cwd)

/**
 * Recent folded by workspace: each cwd once, the folders by their latest update,
 * and the rows inside a folder as the board sorts them. A folder keeps every
 * entry; the rail decides how many of them to draw.
 */
export const recentGroupsOf = (entries: ReadonlyArray<BoardEntry>): ReadonlyArray<RecentGroup> => {
  const byCwd = new Map<string, Array<BoardEntry>>()
  for (const entry of entries) {
    const folder = byCwd.get(entry.summary.cwd)
    if (folder === undefined) byCwd.set(entry.summary.cwd, [entry])
    else folder.push(entry)
  }
  return [...byCwd]
    .map(([cwd, folder]) => ({
      cwd,
      updatedAt: Math.max(...folder.map((entry) => entry.summary.updatedAt)),
      entries: folder.toSorted(
        (left, right) => pinnedFirst(left, right) || newestFirst(left, right),
      ),
    }))
    .toSorted(folderFirst)
}
