import { createSignal } from 'solid-js'
import type { UiCommand, UiEvent } from '@jozo-harness/ui-protocol'
import {
  applyUiEvent,
  initialState,
  withBlank,
  withDeletedPage,
  withDraft,
  withSession,
  withSessions,
  withSettings,
  withTheme,
  withWorkspaces,
  type WebState,
} from '../../src/ui/state.ts'
import type {
  RunStateView,
  SessionAction,
  SessionSummary,
  SettingsView,
} from '../../src/shared/rpc.ts'
import type { SessionStore } from '../store.ts'
import { emptyWatched, watchedAfter, type Watched } from '../../src/ui/board.ts'
import { fixtureSessions, type FixtureSession } from './fixture.ts'

const SETTINGS: SettingsView = {
  model: 'ollama-cloud/qwen3-coder:480b',
  effort: '',
  efforts: ['low', 'high'],
  settingsPath: '/Users/dev/.config/jzh/config.yaml',
  cwd: '/Users/dev/src/jozo-harness',
  sessionRoot: '/Users/dev/.jzh/sessions',
}

/** The models the preview's seat offers, as a provider's list would. */
const MODELS: ReadonlyArray<string> = [
  'ollama-cloud/qwen3-coder:480b',
  'ollama-cloud/glm-5.3',
  'ollama-cloud/gemma4:31b',
]

const RUN: RunStateView = {
  goal: {
    objective: '再接続しても turn を一度だけ数える',
    phase: 'active',
    rounds: 2,
    maxRounds: 8,
  },
  schedules: [
    {
      id: 's1',
      when: 'every 30m',
      title: 'check を回して報告',
      prompt: 'pnpm run check を回して報告',
      lastFiredAt: 0,
    },
  ],
  jobs: [
    {
      id: 'j1a2b3c4d5',
      command: 'pnpm vitest --watch apps/web',
      running: true,
      startedAt: Date.now() - 18_000,
      tail: '✓ 42 tests passed',
    },
  ],
  subagents: [{ id: 'child-9f2a1c3d', status: 'running', startedAt: Date.now() - 42_000 }],
  todos: [
    { content: '失敗する再現テストを書く', status: 'completed' },
    { content: 'runStateOf に射影を足す', status: 'in_progress' },
    { content: 'Run ペインに表示する', status: 'pending' },
  ],
  todoCounts: { pending: 1, inProgress: 1, completed: 1 },
  skills: ['code-complete', 'typescript-best-practices'],
  promptSections: ['identity', 'tool-guidance', 'agents-md:1'],
  queued: [],
  steering: [],
  model: 'ollama-cloud/qwen3-coder:480b',
  effort: 'high',
  efforts: ['low', 'high'],
  usage: {
    total: '371k',
    input: '360k',
    output: '11k',
    turns: 8,
    cache: '94%',
    speed: { text: '42', value: 42 },
    context: { used: '210k', window: '1.0M', left: '380k', share: 0.21, fire: 0.59 },
  },
}

const replay = (state: WebState, events: ReadonlyArray<UiEvent>): WebState =>
  events.reduce(applyUiEvent, state)

/** What answering does to a made-up log: the answer lands as the next event. */
const answered = (session: FixtureSession, command: UiCommand): ReadonlyArray<UiEvent> => {
  const last = session.events[session.events.length - 1]
  const seq = last?.kind === 'session' ? last.event.seq + 1 : 1
  const event = (type: string, data: unknown): UiEvent => ({
    kind: 'session',
    event: { seq, time: Date.now(), type, data },
  })
  if (command.kind === 'approve') {
    return [
      event('safety/approval/answered', { callId: command.callId, approved: command.approved }),
    ]
  }
  if (command.kind === 'answer') return [event('interaction/ask/answered', command)]
  return []
}

/** What a menu action changes in the made-up summary; delete is handled apart. */
const changed = (summary: SessionSummary, action: SessionAction): SessionSummary => {
  switch (action.kind) {
    case 'rename':
      return { ...summary, title: action.title }
    case 'pin':
      return { ...summary, pinned: action.pinned }
    case 'archive':
      return { ...summary, archived: action.archived }
    default:
      return summary
  }
}

/**
 * A store over the made-up sessions, for looking at the page without a model.
 * Moving between sessions replays one; answering appends to it; nothing leaves the page.
 */
export const createPreviewStore = (now = Date.now()): SessionStore => {
  const sessions = [...fixtureSessions(now)]
  // The model and the effort the preview's seat switches, so the chip answers like the real one.
  let model = RUN.model
  let effort = RUN.effort
  const runNow = (): RunStateView => ({ ...RUN, model, effort })
  const open = (id: string | undefined, base: WebState): WebState => {
    const session = sessions.find((item) => item.summary.id === id) ?? sessions[0]
    if (session === undefined) return base
    return { ...replay(withSession(base, session.summary), session.events), run: runNow() }
  }
  // The blank page's seat reads the run's choice from here, as the real one does.
  let settings = SETTINGS
  const first: WebState = {
    ...withSessions(
      {
        ...initialState,
        connected: true,
        settings,
        models: MODELS,
        workspaces: {
          cwd: SETTINGS.cwd,
          items: [
            { cwd: SETTINGS.cwd, lastUsedAt: now },
            { cwd: '/Users/dev/src/fudo', lastUsedAt: now - 60_000 },
          ],
        },
      },
      sessions.map((s) => s.summary),
    ),
  }
  const wanted = new URLSearchParams(location.search).get('session') ?? undefined
  const [state, setState] = createSignal<WebState>(open(wanted, first))
  const follow = (): ReadonlyMap<string, Watched> =>
    new Map(
      sessions.map((item) => [item.summary.id, item.events.reduce(watchedAfter, emptyWatched)]),
    )
  const [watched, setWatched] = createSignal(follow())
  const sendTo = (id: string, command: UiCommand): void => {
    const index = sessions.findIndex((item) => item.summary.id === id)
    const session = sessions[index]
    if (session === undefined) return
    if (command.kind === 'effort') effort = command.effort
    if (command.kind === 'model') model = command.model
    const more = answered(session, command)
    sessions[index] = { ...session, events: [...session.events, ...more] }
    setWatched(follow())
    if (id === state().sessionId) {
      setState((now) => ({ ...replay(now, more), run: runNow() }))
    }
  }
  return {
    state,
    watched,
    start: () => undefined,
    stop: () => undefined,
    setDraft: (text) => setState((now) => withDraft(now, text)),
    submit: () => setState((now) => withDraft(now, '')),
    send: (command) => sendTo(state().sessionId, command),
    sendTo,
    moveTo: (id) => setState((now) => (id === undefined ? withBlank(now) : open(id, now))),
    chooseTheme: (theme) => setState((now) => withTheme(now, theme)),
    showPane: (pane) => setState((now) => ({ ...now, pane })),
    openJob: () => undefined,
    stopJob: () => undefined,
    stopSubagent: () => undefined,
    createSchedule: () => undefined,
    pauseSchedule: () => undefined,
    deleteSchedule: () => undefined,
    askModels: () => undefined,
    askCommands: () => undefined,
    askFiles: () => undefined,
    askWorkspaces: () => undefined,
    // The preview has no disk to read: the dialog opens on the made-up folder alone.
    browseDirectories: (path, reply) =>
      reply({
        kind: 'listed',
        view: { path: path === '' ? SETTINGS.cwd : path, parent: null, items: [] },
      }),
    // The made-up picker grows when the reader adds a folder, so the dialog answers visibly.
    addWorkspace: (cwd) =>
      setState((now) =>
        withWorkspaces(now, {
          cwd: now.workspaces?.cwd ?? SETTINGS.cwd,
          items: [...(now.workspaces?.items ?? []), { cwd, lastUsedAt: 0 }],
        }),
      ),
    // The preview has one session at a time, so the pick is both the switch and
    // the choice the ones opened after it would start from.
    chooseModel: (picked) => {
      model = picked
      setState((now) => ({ ...now, run: runNow() }))
    },
    chooseEffort: (picked) => {
      const current = state()
      if (current.sessionId !== '') {
        sendTo(current.sessionId, { kind: 'effort', effort: picked })
        return
      }
      // Nothing is open: the pick is the run's, as the real seat's is.
      settings = { ...settings, effort: picked }
      setState((now) => withSettings(now, settings))
    },
    setModel: () => undefined,
    pageDeleted: (page) => setState((now) => withDeletedPage(now, page)),
    // The made-up rail keeps its own rows, so the menu is alive without a server.
    act: (id, action) => {
      const index = sessions.findIndex((item) => item.summary.id === id)
      const session = sessions[index]
      if (session === undefined) return
      if (action.kind === 'delete') {
        sessions.splice(index, 1)
        setState((now) => (now.sessionId === id ? withBlank(now) : now))
      } else {
        sessions[index] = { ...session, summary: changed(session.summary, action) }
      }
      setState((now) =>
        withSessions(
          now,
          sessions.map((item) => item.summary),
        ),
      )
    },
  }
}
