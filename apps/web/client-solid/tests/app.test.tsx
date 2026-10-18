import { fireEvent, render } from '@solidjs/testing-library'
import { describe, expect, test } from 'vitest'
import { createSignal } from 'solid-js'
import type { UiCommand } from '@jozo-harness/ui-protocol'
import { emptyConversation } from '@jozo-harness/ui-view'
import { initialState, withDraft, withTheme, type Pane, type WebState } from '../../src/ui/state.ts'
import { Composer } from '../components/composer.tsx'
import { ContextPane } from '../components/context-pane.tsx'
import { Conversation } from '../components/conversation.tsx'
import { Board } from '../components/board.tsx'
import { emptyWatched, watchedAfter, type Watched } from '../../src/ui/board.ts'
import { Waterfall } from '../components/waterfall.tsx'
import { LensSwitch } from '../components/lens-switch.tsx'
import { lensFrom, type Lens } from '../lens.ts'
import type { SessionStore } from '../store.ts'
import { traceOf } from '../../src/ui/trace.ts'

/** One call a component made, in the order it made them. */
type Call =
  | { readonly kind: 'submit' }
  | { readonly kind: 'draft'; readonly text: string }
  | { readonly kind: 'moveTo'; readonly id: string | undefined }
  | { readonly kind: 'pane'; readonly pane: Pane | undefined }
  | { readonly kind: 'command'; readonly command: UiCommand }
  | { readonly kind: 'sendTo'; readonly sessionId: string; readonly command: UiCommand }
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'chooseModel'; readonly model: string }
  | { readonly kind: 'askModels' }

/** A store the components can be rendered against: signals in, calls out. */
const makeStore = (
  overrides: Partial<WebState> = {},
  watched: ReadonlyMap<string, Watched> = new Map(),
) => {
  const [state, setState] = createSignal<WebState>({ ...initialState, ...overrides })
  const calls: Array<Call> = []
  const update = (next: (current: WebState) => WebState): void => {
    setState((current) => next(current))
  }
  const store: SessionStore = {
    state,
    watched: () => watched,
    sendTo: (sessionId, command) => calls.push({ kind: 'sendTo', sessionId, command }),
    start: () => undefined,
    stop: () => undefined,
    setDraft: (text) => {
      calls.push({ kind: 'draft', text })
      update((current) => withDraft(current, text))
    },
    submit: () => calls.push({ kind: 'submit' }),
    send: (command) => calls.push({ kind: 'command', command }),
    moveTo: (id) => calls.push({ kind: 'moveTo', id }),
    chooseTheme: (theme) => update((current) => withTheme(current, theme)),
    showPane: (pane) => calls.push({ kind: 'pane', pane }),
    openJob: () => undefined,
    stopJob: () => undefined,
    askModels: () => calls.push({ kind: 'askModels' }),
    setModel: (model) => calls.push({ kind: 'model', model }),
    chooseModel: (model) => calls.push({ kind: 'chooseModel', model }),
  }
  return { store, calls, setState: update }
}

describe('the Solid page', () => {
  test('the board puts a session that waits first, and answers it in place', () => {
    const asking = [
      {
        kind: 'session' as const,
        event: { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
      },
      {
        kind: 'session' as const,
        event: {
          seq: 2,
          time: 2,
          type: 'safety/approval/requested',
          data: { callId: 'c9', tool: 'bash', reason: 'network' },
        },
      },
    ].reduce(watchedAfter, emptyWatched)
    const { store, calls } = makeStore(
      {
        sessions: [
          {
            id: 'aaaabbbb',
            cwd: '/one/work',
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now() - 60_000,
            title: 'first',
          },
          {
            id: 'ccccdddd',
            cwd: '/two',
            createdAt: Date.now() - 7_200_000,
            updatedAt: Date.now() - 7_200_000,
            title: '',
          },
        ],
        sessionId: 'aaaabbbb',
      },
      new Map([['ccccdddd', asking]]),
    )

    const { container } = render(() => <Board store={store} />)

    const rows = container.querySelectorAll('button.session')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('ccccdddd')
    expect(rows[1]?.classList.contains('active')).toBe(true)
    expect(container.querySelector('.board-asked')?.textContent).toBe('Approve bash? network')

    const allow = [...container.querySelectorAll('.board-card button')].find(
      (button) => button.textContent === 'Allow',
    )
    fireEvent.click(allow as Element)
    expect(calls).toContainEqual({
      kind: 'sendTo',
      sessionId: 'ccccdddd',
      command: { kind: 'approve', callId: 'c9', approved: true },
    })
    fireEvent.click(rows[1] as Element)
    expect(calls).toContainEqual({ kind: 'moveTo', id: 'aaaabbbb' })
  })

  test('the rail draws a session in one line, with the time at the right', () => {
    const now = Date.now()
    const finished = traceOf([
      { seq: 1, time: now - 180_000, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 2,
        time: now - 60_000,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ])
    const { store } = makeStore(
      {
        sessions: [
          {
            id: 'aaaabbbb',
            cwd: '/one/work',
            createdAt: now - 60_000,
            updatedAt: now - 60_000,
            title: 'first',
          },
          {
            id: 'ccccdddd',
            cwd: '/two/project-tail',
            createdAt: now - 60_000,
            updatedAt: now - 60_000,
            title: '',
          },
        ],
      },
      new Map([['ccccdddd', { conversation: emptyConversation, trace: finished }]]),
    )

    const { container } = render(() => <Board store={store} />)

    const rows = [...container.querySelectorAll('#session-list button.session')]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      // The cwd moved to the hover text, so the row is the mark, the name, and the time.
      expect(row.getAttribute('title')).not.toBeNull()
      expect(row.querySelector('.session-where')).toBeNull()
      expect(row.children).toHaveLength(3)
      expect(row.lastElementChild?.classList.contains('session-detail')).toBe(true)
    }
    expect(rows[0]?.getAttribute('title')).toBe('work')
    expect(rows[0]?.querySelector('.session-detail')?.textContent).toBe('1m')
    // The mark's colour says done; the word is gone from the row.
    expect(rows[0]?.textContent).not.toContain('done')
    expect(rows[1]?.getAttribute('title')).toBe('project-tail')
    expect(rows[1]?.querySelector('.session-detail')?.textContent).toBe('1m')
  })

  test('the rail keeps the elapsed time and calls at the right of a running row', () => {
    const now = Date.now()
    const running = traceOf([
      { seq: 1, time: now - 5_000, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, time: now - 5_000, type: 'step/start', data: { step: 1 } },
      {
        seq: 3,
        time: now - 1_000,
        type: 'tool/call',
        data: { callId: 'c1', name: 'bash', arguments: '{}', summary: 'pnpm test' },
      },
    ])
    const { store } = makeStore(
      {
        sessions: [
          {
            id: 'aaaabbbb',
            cwd: '/one/work',
            createdAt: now - 60_000,
            updatedAt: now - 60_000,
            title: 'first',
          },
        ],
      },
      new Map([
        ['aaaabbbb', { conversation: { ...emptyConversation, running: true }, trace: running }],
      ]),
    )

    const { container } = render(() => <Board store={store} />)

    const row = container.querySelector('button.session')
    expect(row?.querySelector('.session-detail')?.textContent).toMatch(/^\d+s · 1 calls$/)
    expect(container.querySelector('.board-doing')?.textContent).toBe('bash pnpm test')
  })

  test('a turn shows the ask, folds its work into one line, and ends in the answer', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store, calls } = makeStore({
      conversation: { ...emptyConversation, blocks: [{ kind: 'user', text: 'hello' }] },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'agent/inbox/claimed', { message: { text: 'hello', source: 'user' } }),
        at(3, 'step/start', { step: 1 }),
        at(4, 'tool/call', {
          callId: 'c1',
          name: 'edit',
          arguments: '{"path":"a.ts"}',
          summary: 'a.ts',
        }),
        at(5, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'lines: 1 → 2',
          content: [{ type: 'text', text: 'the file said so' }],
        }),
        at(6, 'step/end', { step: 1 }),
        at(7, 'step/start', { step: 2 }),
        at(8, 'assistant/message', { content: [{ type: 'text', text: '# Heading' }] }),
        at(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    expect(container.querySelector('.block.user .body')?.textContent).toBe('hello')
    expect(container.querySelector('.process-count')?.textContent).toBe('2 steps, 1 call')
    expect(container.querySelector('.answer h1')?.textContent).toBe('Heading')
    expect(container.querySelector('.tool-card .tool-output')?.textContent).toBe('the file said so')

    fireEvent.click(container.querySelector('button.change') as Element)
    expect(calls).toContainEqual({ kind: 'pane', pane: { kind: 'changes', path: 'a.ts' } })
  })

  test('an approval answers through the store, from the buttons and from y / n', () => {
    const { store, calls } = makeStore({
      conversation: {
        ...emptyConversation,
        approval: { callId: 'c1', tool: 'bash', reason: 'runs a command' },
      },
    })

    const { container } = render(() => <Composer store={store} />)

    const allow = container.querySelector('#takeover [data-approve="true"]')
    expect(allow?.textContent).toBe('Allow')
    fireEvent.click(allow as Element)
    expect(calls).toContainEqual({
      kind: 'command',
      command: { kind: 'approve', callId: 'c1', approved: true },
    })

    fireEvent.keyDown(document, { key: 'n' })
    expect(calls).toContainEqual({
      kind: 'command',
      command: { kind: 'approve', callId: 'c1', approved: false },
    })
  })

  test('the composer keeps the draft and asks the store to submit it', () => {
    const { store, calls } = makeStore()

    const { container } = render(() => <Composer store={store} />)

    const input = container.querySelector('#input') as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: 'ping' } })
    expect(calls).toContainEqual({ kind: 'draft', text: 'ping' })

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls).toContainEqual({ kind: 'submit' })

    const stop = container.querySelector('#cancel')
    fireEvent.click(stop as Element)
    expect(calls).toContainEqual({ kind: 'command', command: { kind: 'cancel' } })
  })

  test('the seat offers the effort words the endpoint takes, beside the model chip', () => {
    const { store, calls } = makeStore({
      sessionId: 'a',
      info: { cwd: '/work', model: 'stub/model', turns: 1 },
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        model: 'stub/model',
        effort: 'low',
        efforts: ['low', 'high'],
      },
    })

    const { container } = render(() => <Composer store={store} />)

    // The model chip is where it was, saying what this run uses.
    expect(container.querySelector('#seat-model')?.textContent).toBe('stub/model')

    const choice = container.querySelector('#seat-effort') as HTMLSelectElement
    // The provider choosing is one of the choices, and the endpoint's words are the rest.
    expect([...choice.options].map((option) => option.value)).toEqual(['', 'low', 'high'])
    expect(choice.value).toBe('low')

    fireEvent.change(choice, { target: { value: 'high' } })
    expect(calls).toContainEqual({ kind: 'command', command: { kind: 'effort', effort: 'high' } })

    fireEvent.change(choice, { target: { value: '' } })
    expect(calls).toContainEqual({ kind: 'command', command: { kind: 'effort', effort: '' } })
  })

  test('an effort the endpoint does not name still shows, so the seat never lies', () => {
    const { store } = makeStore({
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        model: 'stub/model',
        effort: 'max',
        efforts: ['low', 'high'],
      },
    })

    const { container } = render(() => <Composer store={store} />)

    const choice = container.querySelector('#seat-effort') as HTMLSelectElement
    expect([...choice.options].map((option) => option.value)).toEqual(['', 'low', 'high', 'max'])
    expect(choice.value).toBe('max')
  })

  test('the seat lists the models the provider offers and switches this session to the picked one', () => {
    const { store, calls } = makeStore({
      sessionId: 'a',
      info: { cwd: '/work', model: '', turns: 1 },
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
      models: ['stub/model', 'stub/other'],
    })

    const { container } = render(() => <Composer store={store} />)

    // The chip says what this session asks now, which is the run state's word.
    expect(container.querySelector('#seat-model')?.textContent).toBe('stub/model')
    expect(container.querySelector('#model-list')).toBeNull()

    fireEvent.click(container.querySelector('#seat-model') as Element)

    const options = [...container.querySelectorAll('#model-list button')]
    expect(options.map((option) => option.textContent)).toEqual(['stub/model', 'stub/other'])
    // The one in effect is marked, so the list reads as a choice rather than a menu.
    expect(options[0]?.getAttribute('aria-current')).toBe('true')

    fireEvent.click(options[1] as Element)

    expect(calls).toContainEqual({ kind: 'chooseModel', model: 'stub/other' })
    // The pick closes the list; what it did shows in the chip once the core says so.
    expect(container.querySelector('#model-list')).toBeNull()
  })

  test('a seat with no session yet offers the route the next one starts from', () => {
    const { store, calls } = makeStore({
      sessionId: '',
      settings: {
        model: 'stub/model',
        effort: '',
        settingsPath: '/work/settings.yml',
        cwd: '/work',
        sessionRoot: '/work/sessions',
      },
      models: ['stub/model', 'stub/other'],
    })

    const { container } = render(() => <Composer store={store} />)

    // Nothing is open, so the chip says what a session opened now would ask.
    expect(container.querySelector('#seat-model')?.textContent).toBe('stub/model')

    fireEvent.click(container.querySelector('#seat-model') as Element)
    const options = [...container.querySelectorAll('#model-list button')]
    // The choice is the one the sessions opened from now on start from, not a switch
    // of a session that is not there.
    expect(container.querySelector('#model-list .card-hint')?.textContent).toContain(
      'the next session starts from it',
    )

    fireEvent.click(options[1] as Element)
    expect(calls).toContainEqual({ kind: 'chooseModel', model: 'stub/other' })
  })

  test('a seat whose models were never read asks for them when the list is opened', () => {
    const { store, calls } = makeStore({
      sessionId: 'a',
      info: { cwd: '/work', model: 'stub/model', turns: 0 },
    })

    const { container } = render(() => <Composer store={store} />)

    fireEvent.click(container.querySelector('#seat-model') as Element)

    // The list is the provider's, so it is asked for when the reader wants it.
    expect(calls).toContainEqual({ kind: 'askModels' })
    expect(container.querySelector('#model-list')?.textContent).toContain('reading the models')
  })

  test('the pane says what a picked model is for, and hands the pick to the store', () => {
    const { store, calls } = makeStore({
      pane: { kind: 'settings' },
      settings: {
        model: 'stub/model',
        effort: '',
        settingsPath: '/work/settings.yml',
        cwd: '/work',
        sessionRoot: '/work/sessions',
      },
      models: ['stub/model', 'stub/other'],
    })

    const { container } = render(() => <ContextPane store={store} />)

    const choice = container.querySelector('#model-choice') as HTMLSelectElement
    choice.value = 'stub/other'
    fireEvent.click(container.querySelector('#use-model') as Element)

    expect(calls).toContainEqual({ kind: 'model', model: 'stub/other' })
  })

  test('the pane reads the run state and hands a tab click to the store', () => {
    const { store, calls } = makeStore({
      pane: { kind: 'run' },
      run: {
        goal: { objective: 'ship the port', phase: 'active', rounds: 1, maxRounds: 8 },
        schedules: [],
        jobs: [],
        todos: [
          { content: 'write the test', status: 'completed' },
          { content: 'fix the code', status: 'in_progress' },
        ],
        todoCounts: { pending: 0, inProgress: 1, completed: 1 },
        skills: ['code-complete'],
        promptSections: ['identity', 'agents-md:1'],
        queued: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })

    const { container } = render(() => <ContextPane store={store} />)

    expect(container.querySelector('.run-objective')?.textContent).toBe('ship the port')
    expect(container.querySelector('.run-phase')?.textContent).toBe('active')
    expect(container.querySelector('.run-todo.in_progress .run-todo-content')?.textContent).toBe(
      'fix the code',
    )
    expect(container.querySelector('.run-todo-counts')?.textContent).toBe('1/2 complete')
    expect(container.querySelector('.run-skill')?.textContent).toBe('code-complete')
    expect(container.querySelectorAll('.run-prompt-section')).toHaveLength(2)
    expect(container.querySelector('.run-prompt-section')?.textContent).toBe('identity')

    const turns = [...container.querySelectorAll('button.tab')].find(
      (tab) => tab.textContent === 'turns',
    )
    fireEvent.click(turns as Element)
    expect(calls).toContainEqual({ kind: 'pane', pane: { kind: 'trajectory' } })
  })

  test('the trace draws each call on its turn, and a call opens in the inspector', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store, calls } = makeStore({
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { step: 1 }),
        at(3, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{}', summary: 'pnpm test' }),
        at(5, 'tool/result', { callId: 'c1', isError: true, summary: 'exit 1', content: [] }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Waterfall store={store} />)

    expect(container.querySelector('.wf-turn-failed')?.textContent).toBe('1 failed')
    const row = container.querySelector('button.wf-row.tool.error')
    expect(row?.querySelector('.wf-took')?.textContent).toBe('2.0s')
    fireEvent.click(row as Element)
    expect(calls).toContainEqual({ kind: 'pane', pane: { kind: 'inspect', turn: 1, callId: 'c1' } })
  })

  test('the switch marks the reading on screen and hands over the other', () => {
    const chosen: Array<Lens> = []
    const { container } = render(() => (
      <LensSwitch lens="answers" onChoose={(lens) => chosen.push(lens)} />
    ))

    const pressed = container.querySelector('button[aria-pressed="true"]')
    expect(pressed?.textContent).toBe('Answers')
    fireEvent.click(container.querySelector('button[data-lens="timeline"]') as Element)
    expect(chosen).toEqual(['timeline'])
    expect([lensFrom('timeline'), lensFrom('waterfall'), lensFrom(null)]).toEqual([
      'timeline',
      'answers',
      'answers',
    ])
  })
})
