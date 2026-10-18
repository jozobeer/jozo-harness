import { describe, expect, test } from 'vitest'
import type { UiEvent } from '@jozo-harness/ui-protocol'
import {
  applyUiEvent,
  initialState,
  withBranch,
  withConnection,
  withDraft,
  withFiles,
  withModels,
  withPane,
  withProblem,
  withRun,
  withSession,
  withSessions,
  withSettings,
  withTheme,
  withWorkspaces,
} from '../src/ui/state.ts'

let seq = 0
const session = (type: string, data: unknown): UiEvent => {
  seq += 1
  return { kind: 'session', event: { seq, time: seq, type, data } }
}

const fold = (events: ReadonlyArray<UiEvent>) => events.reduce(applyUiEvent, initialState)

const a = { id: 'a', cwd: '/work/one', createdAt: 1, updatedAt: 1, title: 'count the files' }
const b = { id: 'b', cwd: '/work/two', createdAt: 2, updatedAt: 2, title: '' }

describe('the browser state', () => {
  test('the header learns where the session runs and what answers it', () => {
    const state = fold([
      session('session/header', { formatVersion: 1, createdAt: 0, cwd: '/work/a' }),
      session('request/header', {
        provider: 'ollama-cloud',
        model: 'deepseek-v4.1-flash',
        params: {},
        tools: [],
        series: 1,
        reason: 'opened',
      }),
      session('turn/start', { turn: 1 }),
      session('turn/start', { turn: 2 }),
    ])
    expect(state.info).toEqual({
      cwd: '/work/a',
      model: 'ollama-cloud/deepseek-v4.1-flash',
      turns: 2,
    })
  })

  test('a moved working directory follows in the header', () => {
    const state = fold([
      session('session/header', { formatVersion: 1, createdAt: 0, cwd: '/work/a' }),
      session('session/cwd/changed', { cwd: '/work/b' }),
    ])
    expect(state.info.cwd).toBe('/work/b')
  })

  test('an event body that is not the shape it claims leaves the header alone', () => {
    const state = fold([
      session('request/header', 'not a header'),
      session('turn/start', { turn: 'not a number' }),
    ])
    expect(state.info).toEqual({ cwd: '', model: '', turns: 0 })
  })

  test('the trace grows one event at a time, and a replayed event does not count twice', () => {
    const start = session('turn/start', { turn: 1 })
    const step = session('step/start', { step: 1 })
    const call = session('tool/call', {
      callId: 'c1',
      name: 'bash',
      arguments: '{}',
      summary: 'ls',
    })
    const state = fold([start, step, call, call])

    expect(state.trace.map((turn) => turn.steps.map((step) => step.tools.length))).toEqual([[1]])
    expect(withSession(state, a).trace).toEqual([])
  })

  test('the list a page opens with is what its sidebar shows', () => {
    const state = withSessions(initialState, [b, a])
    expect(state.sessions).toEqual([b, a])
    expect(state.sessionId).toBe('')
  })

  test('showing another session clears the conversation and joins the list', () => {
    const talking = applyUiEvent(
      withSession(initialState, a),
      session('user/message', { text: 'hello', source: 'user' }),
    )
    expect(talking.conversation.blocks).toHaveLength(1)
    const moved = withSession(talking, b)
    expect(moved.sessionId).toBe('b')
    expect(moved.conversation.blocks).toHaveLength(0)
    expect(moved.sessions.map((item) => item.id)).toEqual(['a', 'b'])
  })

  test('the file answer belongs to its session and is dropped on a move', () => {
    const matches = { sessionId: 'a', query: 'comp', paths: ['apps/web/composer.tsx'] }
    const shown = withFiles(withSession(initialState, a), matches)
    expect(shown.files).toEqual(matches)
    // Reopening the session already on screen keeps its answer; another starts over.
    expect(withSession(shown, a).files).toEqual(matches)
    expect(withSession(shown, b).files).toBeUndefined()
  })

  test('the theme a reader picks is what the page keeps', () => {
    expect(initialState.theme).toBe('system')
    expect(withTheme(initialState, 'dark').theme).toBe('dark')
  })

  test('the header keeps the branch its workspace stands on beside the path', () => {
    const branched = withBranch(withSession(initialState, a), 'feature/status-bar')
    expect(branched.info).toEqual({ cwd: '', model: '', turns: 0, branch: 'feature/status-bar' })
    // The branch belongs to the session that named it: a move starts the header over.
    expect(withSession(branched, b).info.branch).toBeUndefined()
  })

  test('a problem the page could not act on is shown until the next move', () => {
    const failed = withProblem(withSession(initialState, a), 'the session is gone')
    expect(failed.problem).toBe('the session is gone')
    expect(withSession(failed, b).problem).toBe('')
    // Reopening the session already on screen is no move: the line stands, so a
    // page that reopens a session it was refused keeps saying why.
    expect(withSession(failed, a).problem).toBe('the session is gone')
  })

  test('every move the page makes lands in the field it names', () => {
    const settings = {
      model: 'stub/model',
      effort: 'low',
      settingsPath: '/home/.config/jzh/config.yml',
      cwd: '/work/one',
      sessionRoot: '/home/.jzh/sessions',
    }
    const run = {
      goal: null,
      schedules: [],
      jobs: [],
      subagents: [],
      todos: [],
      todoCounts: { pending: 0, inProgress: 0, completed: 0 },
      skills: [],
      promptSections: [],
      queued: ['hold this'],
      model: 'stub/model',
      effort: '',
      efforts: [],
    }
    const connected = withConnection(initialState, true)
    const drafted = withDraft(connected, 'half typed')
    const shown = withSettings(drafted, settings)
    const listed = withModels(shown, ['stub/model'])
    const inspecting = withPane(listed, { kind: 'inspect', turn: 1, callId: 'c1' })
    const state = withRun(inspecting, run)
    const workspaces = { cwd: '/work/one', items: [{ cwd: '/work/one', lastUsedAt: 1 }] }
    const spread = withWorkspaces(state, workspaces)

    expect(spread.workspaces).toEqual(workspaces)
    expect(state.connected).toBe(true)
    expect(state.draft).toBe('half typed')
    expect(state.settings).toEqual(settings)
    expect(state.models).toEqual(['stub/model'])
    expect(state.pane).toEqual({ kind: 'inspect', turn: 1, callId: 'c1' })
    expect(state.run).toEqual(run)
    // None of the moves names the conversation or the trace, so both stay as they were.
    expect(state.conversation).toBe(initialState.conversation)
    expect(state.trace).toBe(initialState.trace)
  })
})
