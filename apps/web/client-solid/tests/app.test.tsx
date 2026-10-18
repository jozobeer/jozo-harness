import { fireEvent, render } from '@solidjs/testing-library'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createSignal } from 'solid-js'
import type { UiCommand } from '@jozo-harness/ui-protocol'
import { emptyConversation } from '@jozo-harness/ui-view'
import { initialState, withDraft, withTheme, type Pane, type WebState } from '../../src/ui/state.ts'
import { App } from '../app.tsx'
import { Composer } from '../components/composer.tsx'
import { ContextPane } from '../components/context-pane.tsx'
import { Conversation } from '../components/conversation.tsx'
import { Board } from '../components/board.tsx'
import { emptyWatched, watchedAfter, type Watched } from '../../src/ui/board.ts'
import { Markdown } from '../components/turns.tsx'
import { Waterfall } from '../components/waterfall.tsx'
import { LensSwitch } from '../components/lens-switch.tsx'
import { lensFrom, type Lens } from '../lens.ts'
import type { SessionStore } from '../store.ts'
import type { SessionAction } from '../../src/shared/rpc.ts'
import { traceOf } from '../../src/ui/trace.ts'
import {
  RAIL_COLLAPSED_KEY,
  RAIL_KEY,
  railCollapsedFrom,
  railStateOf,
  railWidthFrom,
} from '../rail.ts'
import { RECENT_FOLDED_KEY, RECENT_SHOWN_KEY } from '../recent.ts'

/** One call a component made, in the order it made them. */
type Call =
  | { readonly kind: 'submit' }
  | { readonly kind: 'draft'; readonly text: string }
  | { readonly kind: 'moveTo'; readonly id: string | undefined; readonly cwd?: string | undefined }
  | { readonly kind: 'pane'; readonly pane: Pane | undefined }
  | { readonly kind: 'command'; readonly command: UiCommand }
  | { readonly kind: 'sendTo'; readonly sessionId: string; readonly command: UiCommand }
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'chooseModel'; readonly model: string }
  | { readonly kind: 'askModels' }
  | { readonly kind: 'askCommands' }
  | { readonly kind: 'askFiles'; readonly query: string }
  | { readonly kind: 'act'; readonly sessionId: string; readonly action: SessionAction }
  | { readonly kind: 'askWorkspaces' }
  | { readonly kind: 'addWorkspace'; readonly cwd: string }

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
    moveTo: (id, cwd) => calls.push({ kind: 'moveTo', id, cwd }),
    chooseTheme: (theme) => update((current) => withTheme(current, theme)),
    showPane: (pane) => calls.push({ kind: 'pane', pane }),
    openJob: () => undefined,
    stopJob: () => undefined,
    askModels: () => calls.push({ kind: 'askModels' }),
    askCommands: () => calls.push({ kind: 'askCommands' }),
    askFiles: (query) => calls.push({ kind: 'askFiles', query }),
    setModel: (model) => calls.push({ kind: 'model', model }),
    chooseModel: (model) => calls.push({ kind: 'chooseModel', model }),
    act: (sessionId, action) => calls.push({ kind: 'act', sessionId, action }),
    askWorkspaces: () => calls.push({ kind: 'askWorkspaces' }),
    addWorkspace: (cwd) => calls.push({ kind: 'addWorkspace', cwd }),
  }
  return { store, calls, setState: update }
}

/** jsdom has no clipboard; lend the page one, then take it back. */
const lendClipboard = (writeText: (text: string) => Promise<void>): void => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

const takeBackClipboard = (): void => {
  Reflect.deleteProperty(navigator, 'clipboard')
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

  test('the rail narrows to the sessions whose title or folder says what was typed', () => {
    const { store } = makeStore({
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
          cwd: '/two/project-tail',
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 60_000,
          title: 'second',
        },
      ],
    })

    const { container } = render(() => <Board store={store} />)

    const search = container.querySelector('#session-search') as HTMLInputElement
    const ids = () =>
      [...container.querySelectorAll('#session-list button.session')].map((row) =>
        row.getAttribute('data-session-id'),
      )

    fireEvent.input(search, { target: { value: 'PROJECT' } })
    expect(ids()).toEqual(['ccccdddd'])

    fireEvent.input(search, { target: { value: 'work' } })
    expect(ids()).toEqual(['aaaabbbb'])

    fireEvent.input(search, { target: { value: 'nothing here' } })
    expect(ids()).toEqual([])
    expect(container.querySelector('.board-empty')?.textContent).toContain('nothing here')

    // Escape clears the search and hands the keys back to the page.
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search.value).toBe('')
    expect(ids()).toHaveLength(2)
    expect(document.activeElement).not.toBe(search)
  })

  test('the page opens the search from / or Mod+K, but not while a field has the keys', () => {
    const { store } = makeStore({
      sessions: [
        {
          id: 'aaaabbbb',
          cwd: '/one/work',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          title: 'first',
        },
      ],
    })

    const { container } = render(() => <Board store={store} />)
    const search = container.querySelector('#session-search') as HTMLInputElement

    fireEvent.keyDown(document, { key: '/' })
    expect(document.activeElement).toBe(search)
    search.blur()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(document.activeElement).toBe(search)
    search.blur()

    const field = document.createElement('textarea')
    document.body.append(field)
    field.focus()
    fireEvent.keyDown(field, { key: '/' })
    expect(document.activeElement).toBe(field)
    field.remove()
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
          summary: 'edit a.ts',
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
    expect(container.querySelector('.tool-card .tool-summary')?.textContent).toBe('a.ts')
    expect(container.querySelector('.tool-card .tool-output')?.textContent).toBe('the file said so')

    fireEvent.click(container.querySelector('button.change') as Element)
    expect(calls).toContainEqual({ kind: 'pane', pane: { kind: 'changes', path: 'a.ts' } })
  })

  test('a skill load is a card naming what it loaded, from where, and folds the body', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const path = '/home/me/.jzh/skills/review/SKILL.md'
    const { store } = makeStore({
      conversation: { ...emptyConversation, blocks: [{ kind: 'user', text: '/review' }] },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'agent/inbox/claimed', { message: { text: '/review', source: 'user' } }),
        at(3, 'step/start', { step: 1 }),
        at(4, 'tool/call', {
          callId: 's1',
          name: 'skill',
          arguments: '{"name":"review"}',
          summary: path,
        }),
        at(5, 'tool/result', {
          callId: 's1',
          isError: false,
          summary: 'review does things',
          content: [{ type: 'text', text: '# review\ncheck the diff' }],
        }),
        at(6, 'step/end', { step: 1 }),
        at(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    const card = container.querySelector('.tool-card.skill-card') as HTMLDetailsElement | null
    expect(card?.querySelector('.skill-name')?.textContent).toBe('review')
    expect(card?.querySelector('.skill-source')?.textContent).toBe(path)
    expect(card?.querySelector('.skill-description')?.textContent).toBe('review does things')
    expect(card?.querySelector('.tool-output')?.textContent).toBe('# review\ncheck the diff')
    expect(card?.open).toBe(false)
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
  })

  test('the composer names its icon actions, and Stop only cancels a run', () => {
    const idle = makeStore()
    const first = render(() => <Composer store={idle.store} />)
    const send = first.container.querySelector('#send') as HTMLButtonElement
    const idleStop = first.container.querySelector('#cancel') as HTMLButtonElement
    expect(send.getAttribute('aria-label')).toBe('Send the message')
    expect(send.querySelector('svg')).not.toBeNull()
    expect(idleStop.getAttribute('aria-label')).toBe('Stop the run')
    expect(idleStop.querySelector('svg')).not.toBeNull()
    expect(idleStop.disabled).toBe(true)
    first.unmount()

    const running = makeStore({ conversation: { ...emptyConversation, running: true } })
    const second = render(() => <Composer store={running.store} />)
    const stop = second.container.querySelector('#cancel') as HTMLButtonElement
    expect(stop.disabled).toBe(false)
    fireEvent.click(stop)
    expect(running.calls).toContainEqual({ kind: 'command', command: { kind: 'cancel' } })
  })

  test('the send action gives up primary while a card waits on the reader', () => {
    const plain = makeStore()
    const idle = render(() => <Composer store={plain.store} />)
    expect(idle.container.querySelector('#send')?.className).toContain('bg-accent')
    idle.unmount()

    const waiting = makeStore({
      conversation: {
        ...emptyConversation,
        running: true,
        approval: { callId: 'c1', tool: 'bash', reason: 'runs a command' },
      },
    })
    const takeover = render(() => <Composer store={waiting.store} />)
    expect(takeover.container.querySelector('#send')?.className).not.toContain('bg-accent')
  })

  test('the goal bar above the composer sends the goal commands the store carries', () => {
    const run = (phase: 'active' | 'paused') => ({
      goal: { objective: 'ship it', phase, rounds: 2, maxRounds: 8 },
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
    })
    const { store, calls } = makeStore({ sessionId: 'a', run: run('active') })
    const { container } = render(() => <Composer store={store} />)

    const bar = container.querySelector('#goal-bar')
    expect(bar?.textContent).toContain('ship it')
    expect(bar?.textContent).toContain('active')
    expect(bar?.textContent).toContain('2/8')

    // The rules stay in the command: a button only says what the human typed.
    fireEvent.click(container.querySelector('[data-goal-action="pause"]') as Element)
    expect(calls).toContainEqual({
      kind: 'command',
      command: { kind: 'submit', text: '/goal pause' },
    })
    fireEvent.click(container.querySelector('[data-goal-action="done"]') as Element)
    expect(calls).toContainEqual({
      kind: 'command',
      command: { kind: 'submit', text: '/goal done' },
    })

    // Edit puts the command in the draft, so the objective is changed where it is read.
    fireEvent.click(container.querySelector('[data-goal-action="edit"]') as Element)
    expect(calls).toContainEqual({ kind: 'draft', text: '/goal edit ship it' })
  })

  test('a paused goal offers resume instead of pause', () => {
    const run = {
      goal: { objective: 'ship it', phase: 'paused' as const, rounds: 2, maxRounds: 8 },
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
    }
    const { store, calls } = makeStore({ sessionId: 'a', run })
    const { container } = render(() => <Composer store={store} />)

    expect(container.querySelector('[data-goal-action="pause"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-goal-action="resume"]') as Element)
    expect(calls).toContainEqual({
      kind: 'command',
      command: { kind: 'submit', text: '/goal resume' },
    })
  })

  test('the + menu holds no rules: every item sends a command or starts one in the draft', () => {
    const { store, calls } = makeStore({ sessionId: 'a' })
    const { container } = render(() => <Composer store={store} />)

    fireEvent.click(container.querySelector('#composer-plus') as Element)
    const items = [...container.querySelectorAll('[data-plus-action]')]
    expect(items.map((item) => item.getAttribute('data-plus-action'))).toEqual([
      'goal',
      'compact',
      'model',
      'effort',
    ])

    // A word that wants input moves to the composer; the rule stays in the command.
    fireEvent.click(container.querySelector('[data-plus-action="goal"]') as Element)
    expect(calls).toContainEqual({ kind: 'draft', text: '/goal ' })

    fireEvent.click(container.querySelector('#composer-plus') as Element)
    fireEvent.click(container.querySelector('[data-plus-action="compact"]') as Element)
    expect(calls).toContainEqual({
      kind: 'command',
      command: { kind: 'submit', text: '/compact' },
    })

    fireEvent.click(container.querySelector('#composer-plus') as Element)
    fireEvent.click(container.querySelector('[data-plus-action="model"]') as Element)
    expect(calls).toContainEqual({ kind: 'draft', text: '/model ' })

    fireEvent.click(container.querySelector('#composer-plus') as Element)
    fireEvent.click(container.querySelector('[data-plus-action="effort"]') as Element)
    expect(calls).toContainEqual({ kind: 'draft', text: '/effort ' })
  })

  test('a slash on the first word offers the commands, and Enter inserts the picked one', () => {
    const { store, calls } = makeStore({
      sessionId: 'a',
      commands: [
        { name: 'help', summary: 'list the commands this session answers', kind: 'command' },
        { name: 'status', summary: 'where this session stands', kind: 'command' },
      ],
    })

    const { container } = render(() => <Composer store={store} />)

    const input = container.querySelector('#input') as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: '/st' } })

    const options = [...container.querySelectorAll('#command-list button')]
    expect(options.map((option) => option.getAttribute('data-command'))).toEqual(['status'])
    expect(container.querySelector('#command-list')?.textContent).toContain(
      'where this session stands',
    )

    // Enter accepts the candidate; it does not send a half-typed command.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls).toContainEqual({ kind: 'draft', text: '/status ' })
    expect(calls).not.toContainEqual({ kind: 'submit' })
    expect(input.value).toBe('/status ')
    expect(container.querySelector('#command-list')).toBeNull()

    // The word is complete now, so the next Enter sends it.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls).toContainEqual({ kind: 'submit' })
  })

  test('an @ word offers the files of the session, and Enter inserts the picked path', () => {
    const { store, calls } = makeStore({
      sessionId: 'a',
      files: {
        sessionId: 'a',
        query: 'comp',
        paths: ['apps/web/client-solid/components/composer.tsx', 'packages/ui/src/composer.ts'],
      },
    })

    const { container } = render(() => <Composer store={store} />)

    const input = container.querySelector('#input') as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: 'read @comp' } })

    const options = [...container.querySelectorAll('#reference-list button')]
    expect(options.map((option) => option.getAttribute('data-reference'))).toEqual([
      'apps/web/client-solid/components/composer.tsx',
      'packages/ui/src/composer.ts',
    ])
    expect(container.querySelector('#command-list')).toBeNull()

    // Enter accepts the reference; it does not send the half-typed line.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls).toContainEqual({
      kind: 'draft',
      text: 'read @apps/web/client-solid/components/composer.tsx ',
    })
    expect(calls).not.toContainEqual({ kind: 'submit' })
    expect(container.querySelector('#reference-list')).toBeNull()

    // The word is complete now, so the next Enter sends it.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls).toContainEqual({ kind: 'submit' })
  })

  test('the @ word waits before it asks for files, and an empty word asks for none', () => {
    vi.useFakeTimers()
    try {
      const { store, calls } = makeStore({ sessionId: 'a' })
      const { container } = render(() => <Composer store={store} />)
      const input = container.querySelector('#input') as HTMLTextAreaElement

      fireEvent.input(input, { target: { value: '@comp' } })
      expect(calls).not.toContainEqual({ kind: 'askFiles', query: 'comp' })
      vi.advanceTimersByTime(149)
      expect(calls).not.toContainEqual({ kind: 'askFiles', query: 'comp' })
      vi.advanceTimersByTime(1)
      expect(calls).toContainEqual({ kind: 'askFiles', query: 'comp' })

      fireEvent.input(input, { target: { value: '@' } })
      vi.advanceTimersByTime(150)
      expect(calls).not.toContainEqual({ kind: 'askFiles', query: '' })
    } finally {
      vi.useRealTimers()
    }
  })

  test('a slash before the list is read asks for it, and a non-command line stays quiet', () => {
    const { store, calls } = makeStore({ sessionId: 'a' })
    const { container } = render(() => <Composer store={store} />)

    const input = container.querySelector('#input') as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: '/he' } })
    expect(calls).toContainEqual({ kind: 'askCommands' })
    expect(container.querySelector('#command-list')?.textContent).toContain('reading the commands')

    fireEvent.input(input, { target: { value: 'hello /he' } })
    expect(container.querySelector('#command-list')).toBeNull()
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
        at(3, 'tool/call', {
          callId: 'c1',
          name: 'bash',
          arguments: '{}',
          summary: 'bash pnpm test',
        }),
        at(5, 'tool/result', { callId: 'c1', isError: true, summary: 'exit 1', content: [] }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Waterfall store={store} />)

    expect(container.querySelector('.wf-turn-failed')?.textContent).toBe('1 failed')
    const row = container.querySelector('button.wf-row.tool.error')
    expect(row?.querySelector('.wf-name')?.textContent).toBe('bash')
    expect(row?.querySelector('.wf-summary')?.textContent).toBe('pnpm test')
    expect(row?.querySelector('.wf-took')?.textContent).toBe('2.0s')
    fireEvent.click(row as Element)
    expect(calls).toContainEqual({ kind: 'pane', pane: { kind: 'inspect', turn: 1, callId: 'c1' } })
  })

  test('a running turn keeps its finished bars still between events', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    try {
      const at = (seq: number, time: number, type: string, data: unknown) => ({
        seq,
        time,
        type,
        data,
      })
      const { store } = makeStore({
        trace: traceOf([
          at(1, 1_000, 'turn/start', { turn: 1 }),
          at(2, 2_000, 'step/start', { step: 1 }),
          at(3, 3_000, 'tool/call', {
            callId: 'c1',
            name: 'bash',
            arguments: '{}',
            summary: 'pnpm test',
          }),
          at(4, 4_000, 'tool/result', {
            callId: 'c1',
            isError: false,
            summary: 'exit 0',
            content: [],
          }),
          at(5, 5_000, 'step/start', { step: 2 }),
          at(6, 6_000, 'tool/call', {
            callId: 'c2',
            name: 'bash',
            arguments: '{}',
            summary: 'pnpm build',
          }),
        ]),
      })

      const { container } = render(() => <Waterfall store={store} />)
      const done = container.querySelector('button.wf-row.tool.done .wf-bar') as HTMLElement
      const before = done.getAttribute('style')

      vi.advanceTimersByTime(1000)

      expect(done.getAttribute('style')).toBe(before)
    } finally {
      vi.useRealTimers()
    }
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

  test('the row menu renames a session where it sits, and keeps the line when Enter lands', () => {
    const { store, calls } = makeStore({
      sessions: [{ id: 'aaaabbbb', cwd: '/one/work', createdAt: 1, updatedAt: 1, title: 'first' }],
    })

    const { container } = render(() => <Board store={store} />)

    fireEvent.contextMenu(container.querySelector('.session-row') as Element)
    const rename = [...container.querySelectorAll('.session-menu-panel button')].find(
      (button) => button.textContent === 'Rename',
    )
    fireEvent.click(rename as Element)

    const input = container.querySelector('input.session-rename') as HTMLInputElement
    expect(input.value).toBe('first')
    fireEvent.input(input, { target: { value: 'renamed by hand' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(calls).toContainEqual({
      kind: 'act',
      sessionId: 'aaaabbbb',
      action: { kind: 'rename', title: 'renamed by hand' },
    })
  })

  test('the row menu asks a second time before deleting a session', () => {
    const { store, calls } = makeStore({
      sessions: [{ id: 'aaaabbbb', cwd: '/one/work', createdAt: 1, updatedAt: 1, title: 'first' }],
    })

    const { container } = render(() => <Board store={store} />)

    fireEvent.click(container.querySelector('button.session-menu') as Element)
    const remove = [...container.querySelectorAll('.session-menu-panel button')].find(
      (button) => button.textContent === 'Delete',
    )
    fireEvent.click(remove as Element)

    expect(calls.some((call) => call.kind === 'act')).toBe(false)
    expect(container.textContent).toContain('Delete this session?')

    fireEvent.click(container.querySelector('.session-delete-confirm') as Element)

    expect(calls).toContainEqual({
      kind: 'act',
      sessionId: 'aaaabbbb',
      action: { kind: 'delete' },
    })
  })

  test('the row menu copies the whole session id and says so where it stands', async () => {
    const written: Array<string> = []
    lendClipboard((text) => {
      written.push(text)
      return Promise.resolve()
    })
    try {
      const id = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
      const { store } = makeStore({
        sessions: [{ id, cwd: '/one/work', createdAt: 1, updatedAt: 1, title: 'first' }],
      })
      const { container } = render(() => <Board store={store} />)

      fireEvent.click(container.querySelector('button.session-menu') as Element)
      const copy = [...container.querySelectorAll('.session-menu-panel button')].find(
        (button) => button.textContent === 'Copy session ID',
      )
      fireEvent.click(copy as Element)

      await vi.waitFor(() => expect(container.textContent).toContain('Copied'))
      expect(written).toEqual([id])
      expect(container.querySelector('.session-menu-panel')).not.toBeNull()
    } finally {
      takeBackClipboard()
    }
  })

  test('the row menu keeps the id in reach when the clipboard refuses it', async () => {
    lendClipboard(() => Promise.reject(new Error('denied')))
    try {
      const id = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
      const { store } = makeStore({
        sessions: [{ id, cwd: '/one/work', createdAt: 1, updatedAt: 1, title: 'first' }],
      })
      const { container } = render(() => <Board store={store} />)

      fireEvent.click(container.querySelector('button.session-menu') as Element)
      const copy = [...container.querySelectorAll('.session-menu-panel button')].find(
        (button) => button.textContent === 'Copy session ID',
      )
      fireEvent.click(copy as Element)

      await vi.waitFor(() => expect(container.textContent).toContain('Copy failed'))
      expect(container.querySelector('.session-id-fallback')?.textContent).toBe(id)
    } finally {
      takeBackClipboard()
    }
  })

  test('the row menu does not go quiet when the page has no clipboard', async () => {
    takeBackClipboard()
    const { store } = makeStore({
      sessions: [{ id: 'aaaabbbb', cwd: '/one/work', createdAt: 1, updatedAt: 1, title: 'first' }],
    })
    const { container } = render(() => <Board store={store} />)

    fireEvent.click(container.querySelector('button.session-menu') as Element)
    const copy = [...container.querySelectorAll('.session-menu-panel button')].find(
      (button) => button.textContent === 'Copy session ID',
    )
    fireEvent.click(copy as Element)

    await vi.waitFor(() => expect(container.textContent).toContain('Copy failed'))
  })

  test('an archived session stays out of the rail until the reader asks for it', () => {
    const { store } = makeStore({
      sessions: [
        { id: 'aaaabbbb', cwd: '/one/work', createdAt: 10, updatedAt: 10, title: 'here' },
        {
          id: 'ccccdddd',
          cwd: '/one/work',
          createdAt: 5,
          updatedAt: 5,
          title: 'put away',
          archived: true,
        },
      ],
    })

    const { container } = render(() => <Board store={store} />)
    const ids = () =>
      [...container.querySelectorAll('#session-list button.session')].map((row) =>
        row.getAttribute('data-session-id'),
      )

    expect(ids()).toEqual(['aaaabbbb'])

    fireEvent.click(container.querySelector('#show-archived') as Element)

    expect(ids()).toEqual(['aaaabbbb', 'ccccdddd'])
  })
})

describe('the rail', () => {
  beforeEach(() => localStorage.clear())

  test('a kept width is read back inside the range the rail allows', () => {
    expect([
      railWidthFrom(null),
      railWidthFrom('300'),
      railWidthFrom('100'),
      railWidthFrom('900'),
      railWidthFrom('wide'),
    ]).toEqual([280, 300, 264, 420, 280])
    expect(railCollapsedFrom('true')).toBe(true)
    expect([railCollapsedFrom(null), railCollapsedFrom('false')]).toEqual([false, false])
  })

  test('the narrow page lets the drawer decide the rail, not the stored fold', () => {
    localStorage.setItem(RAIL_COLLAPSED_KEY, 'true')
    const listeners: Array<(event: { matches: boolean }) => void> = []
    vi.stubGlobal(
      'matchMedia',
      (media: string): MediaQueryList =>
        ({
          matches: media === '(max-width: 720px)',
          media,
          addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
            listeners.push(listener),
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    )
    try {
      const { store } = makeStore()
      const { container } = render(() => <App store={store} />)
      const shell = container.querySelector('#shell') as HTMLElement
      const toggle = container.querySelector('#drawer-toggle') as HTMLButtonElement
      expect(shell.getAttribute('data-rail')).toBe('collapsed')

      fireEvent.click(toggle)
      expect(shell.getAttribute('data-rail')).toBe('open')
      expect(shell.hasAttribute('data-drawer')).toBe(true)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')

      fireEvent.click(toggle)
      expect(shell.getAttribute('data-rail')).toBe('collapsed')
      expect(shell.hasAttribute('data-drawer')).toBe(false)

      // A wide window hands the rail back to the fold kept from an earlier visit.
      listeners[0]?.({ matches: false })
      expect(shell.getAttribute('data-rail')).toBe('collapsed')
      expect(railStateOf(false, false, true)).toBe('open')
      expect(railStateOf(false, true, true)).toBe('collapsed')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('the status bar keeps the room the pane strip measured', () => {
    let measure: ((width: number) => void) | undefined
    class FakeResizeObserver {
      constructor(
        callback: (
          entries: ReadonlyArray<{ readonly contentRect: { readonly width: number } }>,
        ) => void,
      ) {
        measure = (width) => callback([{ contentRect: { width } }])
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    try {
      const { store } = makeStore()
      const { container } = render(() => <App store={store} />)
      const header = container.querySelector('#status') as HTMLElement
      measure?.(221.4)
      expect(header.style.getPropertyValue('--context-strip-w')).toBe('222px')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('the rail opens at the width and fold kept from an earlier visit', () => {
    localStorage.setItem(RAIL_KEY, '305')
    localStorage.setItem(RAIL_COLLAPSED_KEY, 'true')
    const { store } = makeStore()

    const { container } = render(() => <App store={store} />)

    const shell = container.querySelector('#shell') as HTMLElement
    expect(shell.style.getPropertyValue('--rail-w')).toBe('305px')
    expect(shell.getAttribute('data-rail')).toBe('collapsed')
    expect(container.querySelector('#rail-fold')?.getAttribute('aria-expanded')).toBe('false')
  })

  test('the header button and Mod+B fold the rail and remember it', () => {
    const { store } = makeStore()

    const { container } = render(() => <App store={store} />)

    const shell = container.querySelector('#shell') as HTMLElement
    const fold = container.querySelector('#rail-fold') as HTMLButtonElement
    expect(shell.style.getPropertyValue('--rail-w')).toBe('280px')
    expect(fold.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(fold)
    expect(shell.getAttribute('data-rail')).toBe('collapsed')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('true')

    fireEvent.keyDown(document, { key: 'b', metaKey: true })
    expect(shell.getAttribute('data-rail')).toBe('open')
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('false')

    // The shortcut leaves a field's keys alone.
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    fireEvent.keyDown(field, { key: 'b', metaKey: true })
    expect(shell.getAttribute('data-rail')).toBe('open')
    field.remove()
  })

  test('dragging the boundary keeps the rail in range and remembers the width', () => {
    const { store } = makeStore()

    const { container } = render(() => <App store={store} />)

    const shell = container.querySelector('#shell') as HTMLElement
    const handle = container.querySelector('#rail-resize') as HTMLElement
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-valuenow')).toBe('280')

    fireEvent.pointerDown(handle, { button: 0, clientX: 280 })
    fireEvent.pointerMove(window, { clientX: 500 })
    expect(handle.getAttribute('aria-valuenow')).toBe('420')
    expect(shell.style.getPropertyValue('--rail-w')).toBe('420px')

    fireEvent.pointerMove(window, { clientX: 100 })
    expect(handle.getAttribute('aria-valuenow')).toBe('264')
    fireEvent.pointerUp(window, { clientX: 100 })
    expect(localStorage.getItem(RAIL_KEY)).toBe('264')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('272')
    expect(shell.style.getPropertyValue('--rail-w')).toBe('272px')
    expect(localStorage.getItem(RAIL_KEY)).toBe('272')
  })
})

describe('the recent workspaces', () => {
  beforeEach(() => localStorage.clear())

  const listed = (id: string, cwd: string, updatedAt: number) => ({
    id,
    cwd,
    createdAt: updatedAt,
    updatedAt,
    title: id,
  })

  test('Recent folds by workspace, shows five rows, and Show more keeps the rest in reach', () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      listed('alpha-' + String(index), '/work/alpha', 10_000 - index),
    )
    sessions.push(listed('beta-1', '/work/beta', 5_000))
    const { store } = makeStore({ sessions })

    const { container } = render(() => <Board store={store} />)

    const groups = [...container.querySelectorAll('.recent-group')]
    expect(groups.map((group) => group.getAttribute('data-cwd'))).toEqual([
      '/work/alpha',
      '/work/beta',
    ])
    const head = groups[0]?.querySelector('button.recent-fold') as HTMLButtonElement
    expect(head.textContent).toContain('alpha')
    expect(head.getAttribute('title')).toBe('/work/alpha')
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(groups[0]?.querySelectorAll('button.session')).toHaveLength(5)
    expect(groups[1]?.querySelectorAll('button.session')).toHaveLength(1)

    fireEvent.click(groups[0]?.querySelector('.recent-more') as Element)

    expect(groups[0]?.querySelectorAll('button.session')).toHaveLength(7)
    expect(localStorage.getItem(RECENT_SHOWN_KEY)).toContain('/work/alpha')
  })

  test('a folded workspace stays folded, except the one holding the open session', () => {
    localStorage.setItem(RECENT_FOLDED_KEY, JSON.stringify(['/work/alpha', '/work/beta']))
    const { store } = makeStore({
      sessions: [listed('open-1', '/work/alpha', 10_000), listed('beta-1', '/work/beta', 9_000)],
      sessionId: 'open-1',
    })

    const { container } = render(() => <Board store={store} />)

    const groups = [...container.querySelectorAll('.recent-group')]
    expect(groups[0]?.querySelectorAll('button.session')).toHaveLength(1)
    expect(groups[0]?.querySelector('button.recent-fold')?.getAttribute('aria-expanded')).toBe(
      'true',
    )
    expect(groups[1]?.querySelectorAll('button.session')).toHaveLength(0)
    expect(groups[1]?.querySelector('button.recent-fold')?.getAttribute('aria-expanded')).toBe(
      'false',
    )

    fireEvent.click(groups[1]?.querySelector('button.recent-fold') as Element)

    expect(groups[1]?.querySelectorAll('button.session')).toHaveLength(1)
    expect(localStorage.getItem(RECENT_FOLDED_KEY)).not.toContain('/work/beta')
  })
})

describe('the workspace picker', () => {
  beforeEach(() => localStorage.clear())

  const listed = (cwd: string, lastUsedAt: number) => ({ cwd, lastUsedAt })

  test('New session starts in the folder picked, last used first', () => {
    const { store, calls } = makeStore({
      workspaces: {
        cwd: '/work/server',
        items: [listed('/work/beta', 20), listed('/work/alpha', 10)],
      },
    })

    const { container } = render(() => <Board store={store} />)

    const select = container.querySelector('#workspace') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect([...select.options].map((option) => option.value)).toEqual(['/work/beta', '/work/alpha'])
    expect(select.value).toBe('/work/beta')
    expect(calls).toContainEqual({ kind: 'askWorkspaces' })

    fireEvent.click(container.querySelector('#new-session') as Element)
    expect(calls.at(-1)).toEqual({ kind: 'moveTo', id: undefined, cwd: '/work/beta' })

    fireEvent.change(select, { target: { value: '/work/alpha' } })
    fireEvent.click(container.querySelector('#new-session') as Element)
    expect(calls.at(-1)).toEqual({ kind: 'moveTo', id: undefined, cwd: '/work/alpha' })
  })

  test('the rail keeps the row it drew when only later facts change', () => {
    const now = Date.now()
    const listed = (id: string) => ({
      id,
      cwd: '/work/' + id,
      createdAt: now,
      updatedAt: now,
      title: id,
    })
    const { store, setState } = makeStore({
      sessions: [listed('aaaabbbb'), listed('ccccdddd')],
    })

    const { container } = render(() => <Board store={store} />)
    const rows = [...container.querySelectorAll('.session-row')]
    expect(rows).toHaveLength(2)

    // A keystroke reads the board again; the DOM it already drew stays.
    setState((current) => withDraft(current, 'typing'))
    expect(container.querySelectorAll('.session-row')[0]).toBe(rows[0])
    expect(container.querySelectorAll('.session-row')[1]).toBe(rows[1])

    // So does a relist, even as the row's own text changes.
    setState((current) => ({
      ...current,
      sessions: [{ ...listed('aaaabbbb'), title: 'renamed' }, listed('ccccdddd')],
    }))
    expect(container.querySelectorAll('.session-row')[0]).toBe(rows[0])
    expect(rows[0]?.querySelector('.session-name')?.textContent).toBe('renamed')
  })

  test('a live answer keeps its nodes when the next state carries the same text', () => {
    const writes = vi.spyOn(Element.prototype, 'innerHTML', 'set')
    try {
      const [state, setState] = createSignal({ live: 'streaming **now**' })
      const { container } = render(() => <Markdown text={state().live} />)
      const body = container.firstElementChild as HTMLElement
      const drawn = body.firstChild
      expect(body.querySelector('strong')?.textContent).toBe('now')
      writes.mockClear()

      setState({ live: 'streaming **now**' })

      // A state that carries the same answer does not touch the body at all.
      expect(writes).not.toHaveBeenCalled()
      expect(body.firstChild).toBe(drawn)
      expect(body.querySelector('strong')?.textContent).toBe('now')

      setState({ live: 'streaming **now** more' })

      expect(writes).toHaveBeenCalledTimes(1)
      expect(body.textContent).toBe('streaming now more')
    } finally {
      writes.mockRestore()
    }
  })

  test('the trace stops its clock while the answers lens hides it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    try {
      const at = (seq: number, type: string, data: unknown) => ({
        seq,
        time: seq * 1000,
        type,
        data,
      })
      const { store } = makeStore({
        trace: traceOf([
          at(1, 'turn/start', { turn: 1 }),
          at(2, 'step/start', { step: 1 }),
          at(3, 'tool/call', {
            callId: 'c1',
            name: 'bash',
            arguments: '{}',
            summary: 'pnpm test',
          }),
        ]),
      })
      const [live, setLive] = createSignal(false)

      const { container } = render(() => <Waterfall store={store} live={live()} />)
      const facts = () => container.querySelector('.wf-turn-facts')?.textContent
      const hidden = facts()
      expect(hidden).toContain('9.0s')

      // Five seconds pass behind the answers lens; nothing in the trace is touched.
      vi.advanceTimersByTime(5_000)
      expect(facts()).toBe(hidden)

      // Opened, the clock catches up at once and then ticks.
      setLive(true)
      expect(facts()).toContain('14s')
      vi.advanceTimersByTime(1_000)
      expect(facts()).toContain('15s')
    } finally {
      vi.useRealTimers()
    }
  })

  test('Add workspace sends the path and keeps the field empty for the next one', () => {
    const { store, calls } = makeStore({
      workspaces: { cwd: '/work/server', items: [listed('/work/beta', 20)] },
    })

    const { container } = render(() => <Board store={store} />)

    const field = container.querySelector('#workspace-path') as HTMLInputElement
    expect(field).not.toBeNull()
    fireEvent.input(field, { target: { value: '/work/new' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)

    expect(calls).toContainEqual({ kind: 'addWorkspace', cwd: '/work/new' })
    expect(field.value).toBe('')
  })
})
