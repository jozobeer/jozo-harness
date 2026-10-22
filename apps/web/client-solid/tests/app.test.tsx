import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, createSignal } from 'solid-js'
import type { SubmitMode, UiCommand } from '@jozo-harness/ui-protocol'
import { emptyConversation } from '@jozo-harness/ui-view'
import {
  initialState,
  withDeletedPage,
  withDraft,
  withTheme,
  type Pane,
  type WebState,
} from '../../src/ui/state.ts'
import { App } from '../app.tsx'
import { Composer } from '../components/composer.tsx'
import { ContextPane } from '../components/context-pane.tsx'
import { SpeedDial } from '../components/usage.tsx'
import { elapsedOf } from '../lib.ts'
import { Conversation } from '../components/conversation.tsx'
import { Board } from '../components/board.tsx'
import { Status } from '../components/status.tsx'
import { emptyWatched, watchedAfter, type Watched } from '../../src/ui/board.ts'
import { Markdown } from '../components/turns.tsx'
import { Review } from '../components/review.tsx'
import { Waterfall } from '../components/waterfall.tsx'
import { LensSwitch } from '../components/lens-switch.tsx'
import { lensFrom, type Lens } from '../lens.ts'
import { pourFrom } from '../pour.ts'
import { SEEN_KEY, SeenContext, createSeen, looksFrom } from '../seen.ts'
import type { SessionStore } from '../store.ts'
import type { DirectoryView, SessionAction } from '../../src/shared/rpc.ts'
import { traceOf } from '../../src/ui/trace.ts'
import {
  RAIL_COLLAPSED_KEY,
  RAIL_KEY,
  railCollapsedFrom,
  railStateOf,
  railWidthFrom,
} from '../rail.ts'
import { RECENT_FOLDED_KEY, RECENT_SHOWN_KEY } from '../recent.ts'
import { BUSY_ENTER_KEY } from '../submission.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The folder dialog is portaled to the body, out of the container the render owns,
// so each test hands its DOM back instead of leaving a dialog for the next one.
afterEach(cleanup)

/** One call a component made, in the order it made them. */
type Call =
  | { readonly kind: 'submit'; readonly mode?: SubmitMode }
  | { readonly kind: 'draft'; readonly text: string }
  | { readonly kind: 'moveTo'; readonly id: string | undefined; readonly cwd?: string | undefined }
  | { readonly kind: 'pane'; readonly pane: Pane | undefined }
  | { readonly kind: 'command'; readonly command: UiCommand }
  | { readonly kind: 'sendTo'; readonly sessionId: string; readonly command: UiCommand }
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'chooseModel'; readonly model: string }
  | { readonly kind: 'chooseEffort'; readonly effort: string }
  | { readonly kind: 'askModels' }
  | { readonly kind: 'askCommands' }
  | { readonly kind: 'askFiles'; readonly query: string }
  | { readonly kind: 'act'; readonly sessionId: string; readonly action: SessionAction }
  | { readonly kind: 'askWorkspaces' }
  | { readonly kind: 'addWorkspace'; readonly cwd: string }
  | { readonly kind: 'browseDirectories'; readonly path: string }
  | { readonly kind: 'stopSubagent'; readonly id: string }
  | { readonly kind: 'openJob'; readonly id: string }
  | { readonly kind: 'stopJob'; readonly id: string }

/** What the Add workspace dialog heard about one folder. */
type BrowseAnswer =
  | { readonly kind: 'listed'; readonly view: DirectoryView }
  | { readonly kind: 'refused'; readonly message: string }

/** A store the components can be rendered against: signals in, calls out. */
const makeStore = (
  overrides: Partial<WebState> = {},
  watched: ReadonlyMap<string, Watched> = new Map(),
) => {
  const [state, setState] = createSignal<WebState>({ ...initialState, ...overrides })
  const calls: Array<Call> = []
  const browses: Array<{ readonly path: string; readonly reply: (answer: BrowseAnswer) => void }> =
    []
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
    submit: (mode) =>
      calls.push(mode === undefined ? { kind: 'submit' } : { kind: 'submit', mode }),
    send: (command) => calls.push({ kind: 'command', command }),
    moveTo: (id, cwd) => calls.push({ kind: 'moveTo', id, cwd }),
    chooseTheme: (theme) => update((current) => withTheme(current, theme)),
    showPane: (pane) => calls.push({ kind: 'pane', pane }),
    openJob: (id) => calls.push({ kind: 'openJob', id }),
    stopJob: (id) => calls.push({ kind: 'stopJob', id }),
    stopSubagent: (id) => calls.push({ kind: 'stopSubagent', id }),
    askModels: () => calls.push({ kind: 'askModels' }),
    askCommands: () => calls.push({ kind: 'askCommands' }),
    askFiles: (query) => calls.push({ kind: 'askFiles', query }),
    setModel: (model) => calls.push({ kind: 'model', model }),
    chooseModel: (model) => calls.push({ kind: 'chooseModel', model }),
    chooseEffort: (effort) => calls.push({ kind: 'chooseEffort', effort }),
    act: (sessionId, action) => calls.push({ kind: 'act', sessionId, action }),
    askWorkspaces: () => calls.push({ kind: 'askWorkspaces' }),
    addWorkspace: (cwd) => calls.push({ kind: 'addWorkspace', cwd }),
    browseDirectories: (path, reply) => {
      calls.push({ kind: 'browseDirectories', path })
      browses.push({ path, reply })
    },
    pageDeleted: (page) => update((current) => withDeletedPage(current, page)),
  }
  return { store, calls, browses, setState: update }
}

/** jsdom has no clipboard; lend the page one, then take it back. */
const lendClipboard = (writeText: (text: string) => Promise<void>): void => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

const takeBackClipboard = (): void => {
  Reflect.deleteProperty(navigator, 'clipboard')
}

/** The accessible label of the mark a selector picks, or nothing when it is absent. */
const labelOf = (root: ParentNode, selector: string): string | null | undefined =>
  root.querySelector(selector)?.getAttribute('aria-label')

/** The text a selector picks, or nothing when it is absent. */
const textOf = (root: ParentNode, selector: string): string | null | undefined =>
  root.querySelector(selector)?.textContent

/** The Add workspace dialog, wherever the page put it. */
const dialogOf = (): HTMLElement => {
  const node = document.querySelector('.workspace-dialog')
  if (!(node instanceof HTMLElement)) throw new Error('the Add workspace dialog is not on the page')
  return node
}

describe('the Solid page', () => {
  test('the board marks how each session ended, green until the reader has seen it', () => {
    const ended = (outcome: string, failure?: object) =>
      [
        { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
        {
          seq: 2,
          time: 2_000,
          type: 'turn/end',
          data: { turn: 1, reason: { kind: outcome, ...failure } },
        },
      ]
        .map((event) => ({ kind: 'session' as const, event }))
        .reduce(watchedAfter, emptyWatched)
    const session = (id: string) => ({
      id,
      cwd: '/work',
      createdAt: 0,
      updatedAt: 2_000,
      title: id,
    })
    const { store } = makeStore(
      { sessions: [session('news'), session('read'), session('broke'), session('cold')] },
      new Map([
        ['news', ended('completed')],
        ['read', ended('completed')],
        ['broke', ended('error', { failure: { code: 'llm', message: 'down' } })],
      ]),
    )
    const seen = { fresh: (id: string) => id !== 'read' }
    const { container } = render(() => (
      <SeenContext.Provider value={seen}>
        <Board store={store} />
      </SeenContext.Provider>
    ))
    const mark = (id: string) =>
      container.querySelector(`button.session[data-session-id="${id}"] .session-mark`)
    expect(mark('news')?.classList.value).toBe('icon end-mark done fresh session-mark')
    expect(mark('read')?.classList.value).toBe('icon end-mark done session-mark')
    expect(mark('broke')?.classList.value).toBe('icon end-mark failed session-mark')
    expect(mark('cold')?.classList.value).toBe('icon end-mark idle session-mark')
  })

  test('a turn cut at the cap, lost with the run, or stopped by hand reads as failed', () => {
    const ended = (outcome: string, extra?: object) =>
      [
        { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
        {
          seq: 2,
          time: 2_000,
          type: 'turn/end',
          data: { turn: 1, reason: { kind: outcome, ...extra } },
        },
      ]
        .map((event) => ({ kind: 'session' as const, event }))
        .reduce(watchedAfter, emptyWatched)
    const session = (id: string) => ({
      id,
      cwd: '/work',
      createdAt: 0,
      updatedAt: 2_000,
      title: id,
    })
    const { store } = makeStore(
      { sessions: [session('cut'), session('lost'), session('stopped')] },
      new Map([
        ['cut', ended('max-tokens')],
        ['lost', ended('interrupted')],
        ['stopped', ended('cancelled', { cause: 'user' })],
      ]),
    )
    const { container } = render(() => <Board store={store} />)
    const marks = [...container.querySelectorAll('.session-row .end-mark')].map(
      (mark) => mark.classList.value,
    )
    expect(marks).toEqual([
      'icon end-mark failed session-mark',
      'icon end-mark failed session-mark',
      'icon end-mark failed session-mark',
    ])
  })

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
    // What waits on you is a glass already: the full mug heads the section, not each card.
    expect(container.querySelector('.board-title .mug.full .mug-foam')).not.toBeNull()
    expect(container.querySelector('.board-card .mug, .board-card .end-mark')).toBeNull()
    expect(rows[1]?.querySelector('.session-mark')).not.toBeNull()

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

  test('the rail keeps a running session in Recent, with no running section or second line', () => {
    const now = Date.now()
    const running = traceOf([
      { seq: 1, time: now - 5_000, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, time: now - 4_000, type: 'step/start', data: { step: 1 } },
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

    expect(container.querySelectorAll('.board-title')).toHaveLength(1)
    expect(container.querySelector('.board-title')?.textContent).toContain('Recent')
    expect(container.querySelector('.board-running')).toBeNull()
    expect(container.querySelector('.board-doing')).toBeNull()
    const row = container.querySelector('.recent-group .session-row')
    expect(row).not.toBeNull()
    expect(row?.querySelector('button.session')?.classList.contains('running')).toBe(true)
    expect(row?.querySelector('.mug.filling.rising')).not.toBeNull()
    // The row keeps the when, not a call count that moves every second.
    expect(row?.querySelector('.session-detail')?.textContent).toBe('now')
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

  test('a failed card names the code the log kept', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      conversation: { ...emptyConversation, blocks: [{ kind: 'user', text: 'go' }] },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { step: 1 }),
        at(3, 'tool/call', {
          callId: 'c1',
          name: 'bash',
          arguments: '{}',
          summary: 'bash sleep 10',
        }),
        at(4, 'tool/result', {
          callId: 'c1',
          isError: true,
          summary: 'timed out after 10000ms',
          content: [{ type: 'text', text: 'timed out after 10000ms' }],
          error: { name: 'TimeoutError', code: 'timeout' },
        }),
        at(5, 'step/end', { step: 1 }),
        at(6, 'assistant/message', { content: [{ type: 'text', text: 'done' }] }),
        at(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    expect(container.querySelector('.tool-card .tool-error')?.textContent).toBe(
      'timeout: the call ran past its limit',
    )
  })

  test('a tool that published a page draws the page under its result line', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      conversation: { ...emptyConversation, blocks: [{ kind: 'user', text: 'go' }] },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { step: 1 }),
        at(3, 'tool/call', {
          callId: 'c1',
          name: 'artifact',
          arguments: '{"name":"report"}',
          summary: 'artifact report',
        }),
        at(4, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'report',
          content: [{ type: 'text', text: 'page: /artifact/s1/report' }],
        }),
        at(5, 'step/end', { step: 1 }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    const frame = container.querySelector('.tool-card iframe')
    expect(frame?.getAttribute('src')).toBe('/artifact/s1/report')
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
    const open = container.querySelector('.tool-card a.tool-page-open')
    expect(open?.getAttribute('href')).toBe('/artifact/s1/report')
    expect(open?.getAttribute('target')).toBe('_blank')
    expect(open?.getAttribute('rel')).toBe('noopener')
    expect(open?.textContent).toBe('Open in a new tab')
  })

  test('a page published by a call inside run_code draws the page', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      conversation: { ...emptyConversation, blocks: [{ kind: 'user', text: 'go' }] },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { step: 1 }),
        at(3, 'tool/call', {
          callId: 'c1',
          name: 'run_code',
          arguments: '{"code":"await tools.artifact({ name: \'report\' })"}',
          summary: 'run_code',
        }),
        at(4, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'published',
          content: [
            {
              type: 'text',
              text: 'return: "published"\npage: /artifact/s1/report',
            },
          ],
        }),
        at(5, 'step/end', { step: 1 }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    const frame = container.querySelector('.tool-card iframe')
    expect(frame?.getAttribute('src')).toBe('/artifact/s1/report')
    const open = container.querySelector('.tool-card a.tool-page-open')
    expect(open?.getAttribute('href')).toBe('/artifact/s1/report')
  })

  test('a run_code result that published two pages draws both frames', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      conversation: { ...emptyConversation, blocks: [{ kind: 'user', text: 'go' }] },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { step: 1 }),
        at(3, 'tool/call', {
          callId: 'c1',
          name: 'run_code',
          arguments: '{}',
          summary: 'run_code',
        }),
        at(4, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'published',
          content: [
            {
              type: 'text',
              text: 'return: "published"\npage: /artifact/s1/report\npage: /artifact/s1/figure',
            },
          ],
        }),
        at(5, 'step/end', { step: 1 }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    const frames = [...container.querySelectorAll('.tool-card iframe')]
    expect(frames.map((frame) => frame.getAttribute('src'))).toEqual([
      '/artifact/s1/report',
      '/artifact/s1/figure',
    ])
    const opens = [...container.querySelectorAll('.tool-card a.tool-page-open')]
    expect(opens.map((open) => open.getAttribute('href'))).toEqual([
      '/artifact/s1/report',
      '/artifact/s1/figure',
    ])
  })

  test('a tool result that is not a page line draws no frame', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      conversation: { ...emptyConversation, blocks: [{ kind: 'user', text: 'go' }] },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { step: 1 }),
        at(3, 'tool/call', {
          callId: 'c1',
          name: 'read',
          arguments: '{"path":"a.ts"}',
          summary: 'read a.ts',
        }),
        at(4, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'lines: 1',
          content: [{ type: 'text', text: 'page: /artifact/s1/report\nand more' }],
        }),
        at(5, 'step/end', { step: 1 }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    expect(container.querySelector('.tool-card iframe')).toBeNull()
  })

  test('the changes pane lists a file with its counts and draws the diff in hunks', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const content = Array.from({ length: 20 }, (_, n) => 'line ' + String(n)).join('\n')
    const { store, calls } = makeStore({
      info: { cwd: '/work', model: '', turns: 2 },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { step: 1 }),
        at(3, 'tool/call', {
          callId: 'c1',
          name: 'edit',
          arguments: JSON.stringify({
            path: 'notes.txt',
            oldString: 'one\ntwo',
            newString: 'one\ntwo\nthree',
          }),
          summary: 'edit notes.txt',
        }),
        at(4, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'lines: 2 → 3',
          content: [],
        }),
        at(5, 'step/end', { step: 1 }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
        at(7, 'turn/start', { turn: 2 }),
        at(8, 'step/start', { step: 1 }),
        at(9, 'tool/call', {
          callId: 'c2',
          name: 'write',
          arguments: JSON.stringify({ path: '/work/notes.txt', content }),
          summary: 'write /work/notes.txt',
        }),
      ]),
    })

    const { container } = render(() => <Review store={store} path="/work/notes.txt" />)

    // One file, however its path was spelled, with what the calls added and took away.
    expect(container.querySelectorAll('.review-file')).toHaveLength(1)
    const file = container.querySelector('.review-file') as HTMLElement
    expect(file.classList.contains('active')).toBe(true)
    expect(textOf(file, '.review-file-path')).toBe('notes.txt')
    expect(textOf(file, '.review-file-edits')).toBe('2 edits')
    expect(textOf(file, '.review-add')).toBe('+23')
    expect(textOf(file, '.review-del')).toBe('−2')

    // The first call reads as a hunk with both gutters, under its header.
    const first = container.querySelectorAll('.edit')[0] as HTMLElement
    expect(textOf(first, '.diff-hunk')).toBe('@@ -1,2 +1,3 @@')
    const gutters = [...first.querySelectorAll('.diff-line')].map((line) =>
      [...line.children].slice(0, 2).map((cell) => cell.textContent),
    )
    expect(gutters).toEqual([
      ['1', ''],
      ['2', ''],
      ['', '1'],
      ['', '2'],
      ['', '3'],
    ])

    // The long write keeps its head and tail until the reader opens the middle.
    const folded = container.querySelector('.diff-fold') as HTMLButtonElement
    expect(folded.textContent).toBe('Show 5 more lines')
    expect(folded.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(folded)
    expect(folded.getAttribute('aria-expanded')).toBe('true')
    expect(folded.textContent).toBe('Fold the middle')
    const second = container.querySelectorAll('.edit')[1] as HTMLElement
    expect(second.querySelectorAll('.diff-line')).toHaveLength(20)

    const wrap = container.querySelector('.review-wrap') as HTMLButtonElement
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    expect((container.querySelector('.diff') as HTMLElement).classList.contains('wrap')).toBe(true)

    // The list hands the pane the normalized path, so a second click finds the same file.
    fireEvent.click(file)
    expect(calls).toContainEqual({ kind: 'pane', pane: { kind: 'changes', path: 'notes.txt' } })
  })

  test('URLs in the prompt, a tool card and its output are links', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      conversation: {
        ...emptyConversation,
        blocks: [{ kind: 'user', text: 'fetch https://example.com/ask' }],
      },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'agent/inbox/claimed', {
          message: { text: 'fetch https://example.com/ask', source: 'user' },
        }),
        at(3, 'step/start', { step: 1 }),
        at(4, 'tool/call', {
          callId: 'c1',
          name: 'web_fetch',
          arguments: '{"url":"https://example.com/page"}',
          summary: 'fetch https://example.com/page',
        }),
        at(5, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'fetched https://example.com/page',
          content: [{ type: 'text', text: 'see https://example.com/out' }],
        }),
        at(6, 'step/end', { step: 1 }),
        at(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    const links = [...container.querySelectorAll('.tool-card a')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.com/page',
      'https://example.com/page',
      'https://example.com/out',
    ])
    expect(links.map((link) => link.textContent)).toEqual([
      'example.com/page',
      'example.com/page',
      'example.com/out',
    ])
    expect(links.map((link) => link.getAttribute('title'))).toEqual([
      'https://example.com/page',
      'https://example.com/page',
      'https://example.com/out',
    ])
    expect(container.querySelector('.turn-ask .body a')?.getAttribute('href')).toBe(
      'https://example.com/ask',
    )
    expect(container.querySelector('.turn-ask .body a')?.textContent).toBe('example.com/ask')

    // A link in the folded line opens the page without folding the card open too.
    const card = container.querySelector('.tool-card') as HTMLDetailsElement
    fireEvent.click(card.querySelector('.tool-summary a') as Element)
    expect(card.open).toBe(false)
  })

  test('a running turn fills a mug from when it began, and rests on a check once it ends', () => {
    const now = Date.now()
    const events = [
      { seq: 1, time: now - 2_000, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, time: now - 1_000, type: 'step/start', data: { step: 1 } },
    ]
    const { store, setState } = makeStore({
      conversation: {
        ...emptyConversation,
        blocks: [{ kind: 'user', text: 'hello' }],
        running: true,
      },
      trace: traceOf(events),
    })

    // The reader opened the session before the turn ended, so its finish is news.
    const seen = { fresh: (_id: string, endedAt: number) => endedAt >= now }
    const { container } = render(() => (
      <SeenContext.Provider value={seen}>
        <Conversation store={store} />
      </SeenContext.Provider>
    ))
    const mug = container.querySelector<SVGElement>('.process-line .mug')
    expect(mug?.classList.contains('filling')).toBe(true)
    // The level starts from the two seconds the turn has run, so a reload keeps it.
    expect(Number.parseFloat(mug?.style.getPropertyValue('--pour-from') ?? '')).toBeLessThanOrEqual(
      -2,
    )
    expect(container.querySelector('.process-line .end-mark')).toBeNull()
    // The fold's mark closes the line, after what the turn has done.
    expect(container.querySelector('.process-line > .process-chevron')).not.toBeNull()

    setState((current) => ({
      ...current,
      conversation: { ...current.conversation, running: false },
      trace: traceOf([
        ...events,
        { seq: 3, time: now, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]),
    }))
    expect(container.querySelector('.process-line .mug')).toBeNull()
    expect(container.querySelector('.process-line .end-mark.done.fresh')).not.toBeNull()
  })

  test('a running turn keeps one line from its first moment, and fills it as calls come and go', () => {
    const now = Date.now()
    const events = [{ seq: 1, time: now - 2_000, type: 'turn/start', data: { turn: 1 } }]
    const { store, setState } = makeStore({
      conversation: {
        ...emptyConversation,
        blocks: [{ kind: 'user', text: 'hello' }],
        running: true,
      },
      trace: traceOf(events),
    })

    const { container } = render(() => <Conversation store={store} />)
    const line = container.querySelector('.process-line')
    const doing = container.querySelector('.process-now')
    expect(line?.querySelector('.process-state')?.textContent).toBe('Working')
    // A turn that has not called a tool yet still says what it is doing.
    expect(doing?.textContent).toBe('thinking')

    // The first call fills the line that is already there instead of adding one.
    setState((current) => ({
      ...current,
      trace: traceOf([
        ...events,
        { seq: 2, time: now - 1_000, type: 'step/start', data: { step: 1 } },
        {
          seq: 3,
          time: now - 500,
          type: 'tool/call',
          data: { callId: 'c1', name: 'bash', arguments: '{}', summary: 'pnpm test' },
        },
      ]),
    }))
    expect(container.querySelector('.process-line')).toBe(line)
    expect(container.querySelector('.process-now')).toBe(doing)
    expect(doing?.textContent).toBe('bash pnpm test')

    // Between two calls the line keeps its place and says the turn is thinking.
    setState((current) => ({
      ...current,
      trace: traceOf([
        ...events,
        { seq: 2, time: now - 1_000, type: 'step/start', data: { step: 1 } },
        {
          seq: 3,
          time: now - 500,
          type: 'tool/call',
          data: { callId: 'c1', name: 'bash', arguments: '{}', summary: 'pnpm test' },
        },
        {
          seq: 4,
          time: now - 400,
          type: 'tool/result',
          data: { callId: 'c1', isError: false, summary: 'ok', content: [] },
        },
      ]),
    }))
    expect(container.querySelector('.process-now')).toBe(doing)
    expect(doing?.textContent).toBe('thinking')
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

  test('a skill loaded outside a turn shows its card without a turn around it', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const path = '/home/me/.agents/skills/review/SKILL.md'
    const { store } = makeStore({
      conversation: {
        ...emptyConversation,
        blocks: [
          {
            kind: 'tool',
            callId: 's1',
            name: 'skill',
            summary: path,
            status: 'done',
            result: 'review does things',
            output: '# review\ncheck the diff',
          },
        ],
      },
      trace: traceOf([
        at(1, 'assistant/message', {
          content: [{ type: 'tool-call', id: 's1', name: 'skill', arguments: '{"name":"review"}' }],
        }),
        at(2, 'tool/call', {
          callId: 's1',
          name: 'skill',
          arguments: '{"name":"review"}',
          summary: path,
        }),
        at(3, 'tool/result', {
          callId: 's1',
          isError: false,
          summary: 'review does things',
          content: [{ type: 'text', text: '# review\ncheck the diff' }],
        }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    const card = container.querySelector('.tool-card.skill-card') as HTMLDetailsElement | null
    expect(card?.querySelector('.skill-name')?.textContent).toBe('review')
    expect(card?.querySelector('.skill-source')?.textContent).toBe(path)
    expect(card?.querySelector('.tool-output')?.textContent).toBe('# review\ncheck the diff')
    // No turn ran, so the card stands alone instead of folding into a process line.
    expect(container.querySelector('.process')).toBeNull()
  })

  test('a read_image result draws the image, its path, bytes, and loaded size', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      conversation: { ...emptyConversation, blocks: [{ kind: 'user', text: 'show it' }] },
      trace: traceOf([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { step: 1 }),
        at(3, 'tool/call', {
          callId: 'i1',
          name: 'read_image',
          arguments: '{"path":"/tmp/a.png"}',
          summary: '',
        }),
        at(4, 'tool/result', {
          callId: 'i1',
          isError: false,
          summary: '',
          content: [
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: '/tmp/a.png' },
          ],
        }),
        at(5, 'step/end', { step: 1 }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]),
    })

    const { container } = render(() => <Conversation store={store} />)

    const image = container.querySelector('.tool-image img') as HTMLImageElement | null
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(image?.getAttribute('loading')).toBe('lazy')
    expect(container.querySelector('.tool-image-meta')?.textContent).toBe('/tmp/a.png8 B')

    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 40 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 20 })
    image?.dispatchEvent(new Event('load'))

    expect(container.querySelector('.tool-image-size')?.textContent).toBe('40×20px')
  })

  test('an approval answers through the store, from the buttons and from y / n', () => {
    const { store, calls } = makeStore({
      conversation: {
        ...emptyConversation,
        approval: { callId: 'c1', tool: 'bash', reason: 'runs a command' },
      },
    })

    const { container } = render(() => <Composer store={store} />)

    // The head of foam names what is asked and the keys that answer it; the reason sits below.
    const head = container.querySelector('#takeover .card-head')
    expect(head?.querySelector('strong')?.textContent).toBe('Approve · bash')
    expect(head?.querySelector('.card-keys')?.textContent).toBe('y / n')
    expect(container.querySelector('#takeover .approval-reason')?.textContent).toBe(
      'runs a command',
    )
    expect(container.querySelector('#takeover .fizz')?.getAttribute('aria-hidden')).toBe('true')

    const allow = container.querySelector('#takeover [data-approve="true"]')
    expect(allow?.textContent).toBe('Allow')
    expect(allow?.className).toContain('bg-foam')
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
    expect(calls).toContainEqual({ kind: 'submit', mode: 'queue' })
  })

  test('the composer sends a running turn the mode the reader picked', () => {
    const running = makeStore({ conversation: { ...emptyConversation, running: true } })
    const { container } = render(() => <Composer store={running.store} busyEnter="steer" />)

    const input = container.querySelector('#input') as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: 'join the step' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(running.calls).toContainEqual({ kind: 'submit', mode: 'steer' })
    // The chip only switches the setting; it does not send the draft.
    fireEvent.click(container.querySelector('#busy-enter') as Element)
    expect(running.calls.filter((call) => call.kind === 'submit')).toHaveLength(1)
  })

  test('the accelerated gesture asks for the other mode, and an idle page always queues', () => {
    const running = makeStore({ conversation: { ...emptyConversation, running: true } })
    const first = render(() => <Composer store={running.store} />)
    const input = first.container.querySelector('#input') as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: 'join now' } })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(running.calls).toContainEqual({ kind: 'submit', mode: 'steer' })
    first.unmount()

    const idle = makeStore()
    const second = render(() => <Composer store={idle.store} />)
    const idleInput = second.container.querySelector('#input') as HTMLTextAreaElement
    fireEvent.input(idleInput, { target: { value: 'later' } })
    fireEvent.keyDown(idleInput, { key: 'Enter', metaKey: true })
    expect(idle.calls).toContainEqual({ kind: 'submit', mode: 'queue' })
  })

  test('the busy-Enter chip shows the mode and hands the switch to the page', () => {
    const running = makeStore({ conversation: { ...emptyConversation, running: true } })
    const chosen: Array<SubmitMode> = []
    const { container } = render(() => (
      <Composer
        store={running.store}
        onBusyEnter={(mode) => {
          chosen.push(mode)
        }}
      />
    ))

    const chip = container.querySelector('#busy-enter') as HTMLButtonElement
    expect(chip.textContent).toBe('queue')
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chip)
    expect(chosen).toEqual(['steer'])

    const idle = makeStore()
    const bare = render(() => <Composer store={idle.store} />)
    expect(bare.container.querySelector('#busy-enter')).toBeNull()
  })

  test('the busy-Enter chip keeps the choice the next page reads', () => {
    localStorage.clear()
    const running = makeStore({ conversation: { ...emptyConversation, running: true } })
    const first = render(() => <App store={running.store} />)
    fireEvent.click(first.container.querySelector('#busy-enter') as Element)
    expect(localStorage.getItem(BUSY_ENTER_KEY)).toBe('steer')
    first.unmount()

    const again = render(() => <App store={running.store} />)
    expect(again.container.querySelector('#busy-enter')?.textContent).toBe('steer')
  })

  test('the queue tells a steer from a line waiting for the next turn', () => {
    const run = {
      goal: null,
      schedules: [],
      jobs: [],
      subagents: [],
      todos: [],
      todoCounts: { pending: 0, inProgress: 0, completed: 0 },
      skills: [],
      promptSections: [],
      queued: ['after this'],
      steering: ['inside now'],
      model: 'stub/model',
      effort: '',
      efforts: [],
    }
    const { store } = makeStore({ sessionId: 'a', run })
    const { container } = render(() => <Composer store={store} />)

    const rows = [...container.querySelectorAll('#queue .queued')]
    expect(rows.map((row) => row.querySelector('.queued-label')?.textContent)).toEqual([
      'steering',
      'queued',
    ])
    expect(rows.map((row) => row.querySelector('.queued-text')?.textContent)).toEqual([
      'inside now',
      'after this',
    ])
    expect(rows[0]?.classList.contains('steering')).toBe(true)
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

  test('the composer keeps the word padding off its icon squares', () => {
    const { store } = makeStore()

    const { container } = render(() => <Composer store={store} />)

    for (const id of ['send', 'cancel']) {
      const button = container.querySelector('#' + id) as HTMLButtonElement
      expect(button.className).toContain('btn-icon')
      // The word button's padding is 28px wide together; inside a 28px square it
      // leaves no room for the glyph, so the icon size must not carry it.
      expect(button.className).not.toContain('px-[14px]')
      expect(button.className).not.toContain('py-[7px]')
    }
  })

  test('the send action gives up primary while a card waits on the reader', () => {
    const plain = makeStore()
    const idle = render(() => <Composer store={plain.store} />)
    expect(idle.container.querySelector('#send')?.className).toContain('bg-accent-fill')
    idle.unmount()

    const waiting = makeStore({
      conversation: {
        ...emptyConversation,
        running: true,
        approval: { callId: 'c1', tool: 'bash', reason: 'runs a command' },
      },
    })
    const takeover = render(() => <Composer store={waiting.store} />)
    expect(takeover.container.querySelector('#send')?.className).not.toContain('bg-accent-fill')
  })

  test('the goal bar above the composer sends the goal commands the store carries', () => {
    const run = (phase: 'active' | 'paused') => ({
      goal: { objective: 'ship it', phase, rounds: 2, maxRounds: 8 },
      schedules: [],
      jobs: [],
      subagents: [],
      todos: [],
      todoCounts: { pending: 0, inProgress: 0, completed: 0 },
      skills: [],
      promptSections: [],
      queued: [],
      steering: [],
      model: 'stub/model',
      effort: '',
      efforts: [],
    })
    const { store, calls } = makeStore({ sessionId: 'a', run: run('active') })
    const { container } = render(() => <Composer store={store} />)

    const bar = container.querySelector('#goal-bar')
    expect(bar?.textContent).toContain('ship it')
    expect(bar?.textContent).toContain('active')
    // The rounds are a count against a limit, not progress, so they are words.
    expect(bar?.querySelector('.goal-rounds')?.textContent).toBe('round 2 / 8')
    expect(bar?.querySelector('.goal-phase .mug.filling')).not.toBeNull()

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

  test('a goal is marked the way work is: a mug while it runs, empty while held, a dot once it stops', () => {
    const markOf = (phase: string) => {
      const { store } = makeStore({
        sessionId: 'a',
        run: {
          goal: { objective: 'ship it', phase, rounds: 8, maxRounds: 8 },
          schedules: [],
          jobs: [],
          subagents: [],
          todos: [],
          todoCounts: { pending: 0, inProgress: 0, completed: 0 },
          skills: [],
          promptSections: [],
          queued: [],
          steering: [],
          model: 'stub/model',
          effort: '',
          efforts: [],
        },
      })
      const { container, unmount } = render(() => <Composer store={store} />)
      const mark = container.querySelector('.goal-phase > svg')?.getAttribute('class')
      unmount()
      return mark
    }
    expect(markOf('active')).toBe('mug filling')
    expect(markOf('paused')).toBe('mug empty')
    expect(markOf('blocked')).toBe('icon goal-mark blocked')
    expect(markOf('complete')).toBe('icon goal-mark complete')
  })

  test('a paused goal offers resume instead of pause', () => {
    const run = {
      goal: { objective: 'ship it', phase: 'paused' as const, rounds: 2, maxRounds: 8 },
      schedules: [],
      jobs: [],
      subagents: [],
      todos: [],
      todoCounts: { pending: 0, inProgress: 0, completed: 0 },
      skills: [],
      promptSections: [],
      queued: [],
      steering: [],
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
    expect(calls).toContainEqual({ kind: 'submit', mode: 'queue' })
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
    expect(calls).toContainEqual({ kind: 'submit', mode: 'queue' })
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

  test('the model chip wraps the whole route instead of hiding it behind an ellipsis', () => {
    const sheet = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/ui/style.css'),
      'utf8',
    )
    const start = sheet.indexOf('.seat-chip {')
    expect(start).toBeGreaterThan(-1)
    const rule = sheet.slice(start, sheet.indexOf('}', start))
    // The route is the model's name, so a narrow composer grows the chip instead
    // of trading the tail of the name for an ellipsis.
    expect(rule).not.toContain('text-overflow')
    expect(rule).not.toContain('white-space: nowrap')
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
  })

  test('the model list wraps a route instead of hiding it behind an ellipsis', () => {
    const sheet = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/ui/style.css'),
      'utf8',
    )
    const start = sheet.indexOf('.model-option {')
    expect(start).toBeGreaterThan(-1)
    const rule = sheet.slice(start, sheet.indexOf('}', start))
    // A route is how a human tells one model from another, so the list keeps
    // the whole name even when it wraps, as the chip already does.
    expect(rule).not.toContain('text-overflow')
    expect(rule).not.toContain('white-space: nowrap')
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
  })

  test('the seat offers the effort words the endpoint takes, beside the model chip', () => {
    const { store, calls } = makeStore({
      sessionId: 'a',
      info: { cwd: '/work', model: 'stub/model', turns: 1 },
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
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
    expect(calls).toContainEqual({ kind: 'chooseEffort', effort: 'high' })

    fireEvent.change(choice, { target: { value: '' } })
    expect(calls).toContainEqual({ kind: 'chooseEffort', effort: '' })
  })

  test('a narrow composer folds the seat behind +, and a wide one keeps it in the row', () => {
    let width = 400
    const observers: Array<() => void> = []
    // jsdom measures nothing, so the width the composer reports is set here.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly report: () => void
        constructor(
          callback: (entries: ReadonlyArray<{ contentRect: { width: number } }>) => void,
        ) {
          this.report = () => callback([{ contentRect: { width } }])
        }
        observe() {
          observers.push(this.report)
          this.report()
        }
        disconnect() {}
      },
    )
    try {
      const { store } = makeStore({
        sessionId: 'a',
        info: { cwd: '/work', model: 'stub/model', turns: 1 },
        run: {
          goal: null,
          schedules: [],
          jobs: [],
          subagents: [],
          todos: [],
          todoCounts: { pending: 0, inProgress: 0, completed: 0 },
          skills: [],
          promptSections: [],
          queued: [],
          steering: [],
          model: 'stub/model',
          effort: 'low',
          efforts: ['low', 'high'],
        },
      })
      const { container } = render(() => <Composer store={store} />)
      expect(container.querySelector('#seat-model')).toBeNull()
      fireEvent.click(container.querySelector('#composer-plus') as Element)
      expect(container.querySelector('#plus-list #seat-model')?.textContent).toBe('stub/model')
      expect(container.querySelector('#plus-list #seat-effort')).not.toBeNull()

      width = 800
      for (const report of observers) report()
      expect(container.querySelector('#plus-list #seat-model')).toBeNull()
      expect(container.querySelector('.actions > #seat #seat-model')).not.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('a row too short for its chips on one line folds them behind +, however wide it is', () => {
    let width = 700
    const observers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly report: () => void
        constructor(
          callback: (entries: ReadonlyArray<{ contentRect: { width: number } }>) => void,
        ) {
          this.report = () => callback([{ contentRect: { width } }])
        }
        observe() {
          observers.push(this.report)
          this.report()
        }
        disconnect() {}
      },
    )
    // jsdom lays nothing out: the row is as wide as reported, and its chips need 760px.
    const scroll = vi
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('actions') ? 760 : 0
      })
    const client = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('actions') ? width : 0
      })
    try {
      const { store } = makeStore({
        sessionId: 'a',
        info: { cwd: '/work', model: 'stub/model', turns: 1 },
      })
      const { container } = render(() => <Composer store={store} />)
      expect(container.querySelector('.actions > #seat')).toBeNull()

      width = 800
      for (const report of observers) report()
      expect(container.querySelector('.actions > #seat')).not.toBeNull()
    } finally {
      scroll.mockRestore()
      client.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  test('an effort the endpoint does not name still shows, so the seat never lies', () => {
    const { store } = makeStore({
      sessionId: 'a',
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
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
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
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
        efforts: ['low', 'high'],
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

  test('a seat with no session yet offers the effort the next one starts from', () => {
    const { store, calls } = makeStore({
      sessionId: '',
      settings: {
        model: 'stub/model',
        effort: 'high',
        efforts: ['low', 'high'],
        settingsPath: '/work/settings.yml',
        cwd: '/work',
        sessionRoot: '/work/sessions',
      },
    })

    const { container } = render(() => <Composer store={store} />)

    // The effort is the one a session opened now would ask, so it shows before the
    // first line rather than appearing only once a session exists.
    const choice = container.querySelector('#seat-effort') as HTMLSelectElement
    expect(choice).not.toBeNull()
    // The provider choosing is one of the choices, and the endpoint's words are the rest.
    expect([...choice.options].map((option) => option.value)).toEqual(['', 'low', 'high'])
    expect(choice.value).toBe('high')

    // The pick is the run's choice, so the session the first line opens starts from it.
    fireEvent.change(choice, { target: { value: 'low' } })
    expect(calls).toContainEqual({ kind: 'chooseEffort', effort: 'low' })
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
        efforts: ['low', 'high'],
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
        schedules: [
          {
            id: 'sched-1',
            when: 'every 60s',
            title: 'check the build',
            prompt: 'run pnpm run check and report',
            lastFiredAt: 0,
          },
        ],
        jobs: [],
        subagents: [],
        todos: [
          { content: 'write the test', status: 'completed' },
          { content: 'fix the code', status: 'in_progress' },
          { content: 'wait for review', status: 'pending' },
        ],
        todoCounts: { pending: 1, inProgress: 1, completed: 1 },
        skills: ['code-complete'],
        promptSections: ['identity', 'agents-md:1'],
        queued: [],
        steering: [],
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
    // The step in progress fills a mug that knows no start, so it holds half full.
    expect(
      container.querySelector('.run-todo.in_progress .mug.filling:not(.rising)'),
    ).not.toBeNull()
    expect(container.querySelector('.run-todo.completed .icon mask')).not.toBeNull()
    // The icon is drawn, so its meaning has to reach a reader who cannot see it.
    expect(labelOf(container, '.run-todo.pending .run-todo-mark')).toBe('not started')
    expect(labelOf(container, '.run-todo.in_progress .run-todo-mark')).toBe('in progress')
    expect(labelOf(container, '.run-todo.completed .run-todo-mark')).toBe('completed')
    expect(container.querySelector('.run-todo-counts')?.textContent).toBe('1/3 complete')
    expect(container.querySelector('.run-skill')?.textContent).toBe('code-complete')
    expect(container.querySelectorAll('.run-prompt-section')).toHaveLength(2)
    expect(container.querySelector('.run-prompt-section')?.textContent).toBe('identity')
    expect(container.querySelector('.run-when')?.textContent).toBe('every 60s')
    expect(container.querySelector('.run-title')?.textContent).toBe('check the build')
    expect(container.querySelector('.run-schedule .run-prompt')?.textContent).toBe(
      'run pnpm run check and report',
    )

    const turns = [...container.querySelectorAll('button.tab')].find(
      (tab) => tab.textContent === 'turns',
    )
    fireEvent.click(turns as Element)
    expect(calls).toContainEqual({ kind: 'pane', pane: { kind: 'trajectory' } })
  })

  test('the run pane lists each page the session published, newest first and once', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const publish = (seq: number, callId: string, page: string) => [
      at(seq, 'tool/call', {
        callId,
        name: 'artifact',
        arguments: '{}',
        summary: 'artifact',
      }),
      at(seq + 1, 'tool/result', {
        callId,
        isError: false,
        summary: '',
        content: [{ type: 'text', text: 'page: ' + page }],
      }),
    ]
    const { store } = makeStore({
      pane: { kind: 'run' },
      trace: traceOf([
        ...publish(1, 'c1', '/artifact/s1/report'),
        ...publish(3, 'c2', '/artifact/s1/notes'),
        ...publish(5, 'c3', '/artifact/s1/report'),
      ]),
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })

    const { container } = render(() => <ContextPane store={store} />)

    const pages = [...container.querySelectorAll('.run-pages .run-page')]
    expect(pages).toHaveLength(2)
    // The same page published twice is one row, and the latest publication leads.
    expect(pages.map((row) => textOf(row, '.run-page-name'))).toEqual(['report', 'notes'])
    expect(pages.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual([
      '/artifact/s1/report',
      '/artifact/s1/notes',
    ])
    expect(pages[0]?.querySelector('a')?.getAttribute('target')).toBe('_blank')
    expect(pages.map((row) => textOf(row, '.run-page-download'))).toEqual(['Download', 'Download'])
    expect(
      pages.map((row) => row.querySelector('.run-page-download')?.getAttribute('href')),
    ).toEqual(['/artifact/s1/report?download=1', '/artifact/s1/notes?download=1'])
  })

  test('the run pane lists every page one run_code result published', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      pane: { kind: 'run' },
      trace: traceOf([
        at(1, 'tool/call', {
          callId: 'c1',
          name: 'run_code',
          arguments: '{}',
          summary: 'run_code',
        }),
        at(2, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'published',
          content: [
            {
              type: 'text',
              text: 'return: "published"\npage: /artifact/s1/report\npage: /artifact/s1/figure',
            },
          ],
        }),
      ]),
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })

    const { container } = render(() => <ContextPane store={store} />)

    const pages = [...container.querySelectorAll('.run-pages .run-page')]
    expect(pages.map((row) => textOf(row, '.run-page-name'))).toEqual(['report', 'figure'])
    expect(pages.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual([
      '/artifact/s1/report',
      '/artifact/s1/figure',
    ])
  })

  test('a page row deletes its page and leaves the list once the route answers 204', async () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const publish = (seq: number, callId: string, page: string) => [
      at(seq, 'tool/call', {
        callId,
        name: 'artifact',
        arguments: '{}',
        summary: 'artifact',
      }),
      at(seq + 1, 'tool/result', {
        callId,
        isError: false,
        summary: '',
        content: [{ type: 'text', text: 'page: ' + page }],
      }),
    ]
    const { store } = makeStore({
      pane: { kind: 'run' },
      trace: traceOf([
        ...publish(1, 'c1', '/artifact/s1/report'),
        ...publish(3, 'c2', '/artifact/s1/notes'),
      ]),
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })
    const asked: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    let answer: (status: number) => void = () => undefined
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      asked.push({ url, init })
      return new Promise((resolved) => {
        answer = (status) => resolved({ status })
      })
    })
    try {
      const { container } = render(() => <ContextPane store={store} />)
      // The newest page leads the list, so its row is the first delete.
      const notes = container.querySelectorAll('.run-page-delete')[0]
      fireEvent.click(notes as Element)

      expect(asked).toEqual([
        {
          url: '/artifact/s1/notes',
          init: { method: 'DELETE', headers: { 'X-Requested-With': 'fetch' } },
        },
      ])
      // A second press while the first is still out would send the same delete twice.
      expect((notes as HTMLButtonElement).disabled).toBe(true)

      answer(204)
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll('.run-page-name')].map((name) => name.textContent),
        ).toEqual(['report']),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('a page row whose delete is refused stays, with the number the route answered', async () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      pane: { kind: 'run' },
      trace: traceOf([
        at(1, 'tool/call', {
          callId: 'c1',
          name: 'artifact',
          arguments: '{}',
          summary: 'artifact',
        }),
        at(2, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: '',
          content: [{ type: 'text', text: 'page: /artifact/s1/report' }],
        }),
      ]),
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })
    vi.stubGlobal('fetch', () => Promise.resolve({ status: 500 }))
    try {
      const { container } = render(() => <ContextPane store={store} />)
      fireEvent.click(container.querySelector('.run-page-delete') as Element)

      await vi.waitFor(() =>
        expect(container.querySelector('.run-page-error')?.textContent).toContain('500'),
      )
      expect(container.querySelectorAll('.run-page')).toHaveLength(1)
      expect(textOf(container, '.run-page-name')).toBe('report')
      expect((container.querySelector('.run-page-delete') as HTMLButtonElement).disabled).toBe(
        false,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('the run pane draws no pages section when no call published one', () => {
    const at = (seq: number, type: string, data: unknown) => ({ seq, time: seq * 1000, type, data })
    const { store } = makeStore({
      pane: { kind: 'run' },
      trace: traceOf([
        at(1, 'tool/call', {
          callId: 'c1',
          name: 'read',
          arguments: '{"path":"a.ts"}',
          summary: 'read a.ts',
        }),
        at(2, 'tool/result', {
          callId: 'c1',
          isError: false,
          summary: 'lines: 1',
          content: [{ type: 'text', text: 'the file' }],
        }),
      ]),
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })

    const { container } = render(() => <ContextPane store={store} />)

    expect(
      [...container.querySelectorAll('.run-section-title')].some(
        (title) => title.textContent === 'pages',
      ),
    ).toBe(false)
    expect(container.querySelector('.run-page')).toBeNull()
  })

  test('the run pane lists running subagents, moves to one, and stops it', () => {
    const { store, calls } = makeStore({
      pane: { kind: 'run' },
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [
          {
            id: 'child-12345678',
            status: 'running',
            startedAt: Date.now() - 3_000,
            preset: 'reviewer',
          },
          {
            id: 'child-9abcdef0',
            status: 'idle',
            startedAt: Date.now() - 90_000,
            preset: 'builder',
            endedAt: Date.now() - 30_000,
          },
        ],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })

    const { container } = render(() => <ContextPane store={store} />)

    const running = container.querySelector('[data-subagent-id="child-12345678"]') as Element
    const idle = container.querySelector('[data-subagent-id="child-9abcdef0"]') as Element
    expect(container.querySelectorAll('.run-child-row')).toHaveLength(2)
    expect(
      container.querySelectorAll('.run-work-subagents .run-section-title')[0]?.textContent,
    ).toBe('subagents')
    expect(textOf(container, '.run-work-subagents .run-work-counts')).toBe('1 running / 1 done')
    // The child that still works comes first, whatever order the core held them in.
    expect(
      [...container.querySelectorAll('.run-child-row')].map((row) =>
        row.getAttribute('data-subagent-id'),
      ),
    ).toEqual(['child-12345678', 'child-9abcdef0'])
    expect(textOf(running, '.run-child-state')).toBe('running')
    expect(textOf(running, '.run-child-id')).toBe('child-12')
    expect(textOf(running, '.run-child-preset')).toBe('reviewer')
    expect(textOf(running, '.run-child-activity')).toBe('working')
    expect(textOf(running, '.run-child-elapsed')).toBe('3s')
    expect(textOf(idle, '.run-child-state')).toBe('idle')
    expect(textOf(idle, '.run-child-preset')).toBe('builder')
    expect(textOf(idle, '.run-child-activity')).toBe('idle')
    expect(textOf(idle, '.run-child-elapsed')).toBe('1m')
    // Only a child that still works offers a stop; an idle one has nothing to stop.
    expect(running.querySelector('.run-child-stop')).not.toBeNull()
    expect(idle.querySelector('.run-child-stop')).toBeNull()

    fireEvent.click(running.querySelector('.run-child') as Element)
    expect(calls).toContainEqual({ kind: 'moveTo', id: 'child-12345678', cwd: undefined })

    // The first press arms the stop; the second one is the one that ends the child.
    const stop = running.querySelector('.run-child-stop') as Element
    fireEvent.click(stop)
    expect(stop.classList.contains('armed')).toBe(true)
    expect(stop.textContent).toBe('press again')
    expect(calls).not.toContainEqual({ kind: 'stopSubagent', id: 'child-12345678' })
    fireEvent.click(stop)
    expect(calls).toContainEqual({ kind: 'stopSubagent', id: 'child-12345678' })
  })

  test('the run pane lists a running job with its elapsed time, tail, and a stop', () => {
    const startedAt = Date.now() - 3_000
    const { store, calls } = makeStore({
      pane: { kind: 'run' },
      run: {
        goal: null,
        schedules: [],
        jobs: [
          {
            id: 'job-9f8e7d6c',
            command: 'pnpm build',
            running: false,
            startedAt: startedAt - 60_000,
            endedAt: startedAt - 58_000,
            tail: 'built in 2s',
          },
          {
            id: 'job-1a2b3c4d',
            command: 'pnpm vitest --watch',
            running: true,
            startedAt,
            tail: 'RUN v4.0.3',
          },
        ],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })

    const { container } = render(() => <ContextPane store={store} />)

    const running = container.querySelector('[data-job-id="job-1a2b3c4d"]') as Element
    const done = container.querySelector('[data-job-id="job-9f8e7d6c"]') as Element
    expect(container.querySelectorAll('.run-job-row')).toHaveLength(2)
    expect(textOf(container, '.run-work-jobs .run-work-counts')).toBe('1 running / 1 done')
    // Running work leads; a finished job is not ahead of it merely because it started first.
    expect(
      [...container.querySelectorAll('.run-job-row')].map((row) => row.getAttribute('data-job-id')),
    ).toEqual(['job-1a2b3c4d', 'job-9f8e7d6c'])
    expect(textOf(running, '.run-job-state')).toBe('running')
    expect(textOf(running, '.run-job-command')).toBe('pnpm vitest --watch')
    expect(textOf(running, '.run-job-elapsed')).toBe('3s')
    expect(running.querySelector('.run-job-dot')?.classList.contains('running')).toBe(true)
    expect(textOf(running, '.run-job-tail')).toBe('RUN v4.0.3')
    // Only a job that still runs offers a stop; a finished one has nothing to stop.
    expect(running.querySelector('.run-job-stop')).not.toBeNull()
    expect(done.querySelector('.run-job-stop')).toBeNull()
    expect(textOf(done, '.run-job-state')).toBe('finished')
    expect(textOf(done, '.run-job-elapsed')).toBe('2s')
    expect(textOf(done, '.run-job-tail')).toBe('built in 2s')

    // What finished waits folded behind its own count until the reader opens it.
    const folded = container.querySelector('[data-jobs-done]') as HTMLDetailsElement
    expect(folded).not.toBeNull()
    expect(folded.open).toBe(false)
    expect(textOf(folded, '.run-work-done-head')).toContain('1')

    fireEvent.click(running.querySelector('.run-job') as Element)
    expect(calls).toContainEqual({ kind: 'openJob', id: 'job-1a2b3c4d' })

    // The first press arms the stop; the second one is the one that ends the job.
    const stop = running.querySelector('.run-job-stop') as Element
    fireEvent.click(stop)
    expect(stop.classList.contains('armed')).toBe(true)
    expect(stop.textContent).toBe('press again')
    expect(calls).not.toContainEqual({ kind: 'stopJob', id: 'job-1a2b3c4d' })
    fireEvent.click(stop)
    expect(calls).toContainEqual({ kind: 'stopJob', id: 'job-1a2b3c4d' })
  })

  test('a session with no live child keeps the links its finished subagents left', () => {
    const { store, calls } = makeStore({
      pane: { kind: 'run' },
      conversation: {
        ...emptyConversation,
        blocks: [
          {
            kind: 'tool',
            callId: 'c1',
            name: 'subagent',
            summary: 'subagent',
            status: 'done',
            output: 'the child said so\n\n[child session: child-old]',
            result: 'the child said so',
          },
        ],
      },
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
      },
    })

    const { container } = render(() => <ContextPane store={store} />)

    expect(container.querySelectorAll('.run-child-row')).toHaveLength(0)
    const link = container.querySelector('.run-child') as Element
    expect(link.textContent).toBe('subagent · child-ol')
    fireEvent.click(link)
    expect(calls).toContainEqual({ kind: 'moveTo', id: 'child-old', cwd: undefined })
  })

  test('elapsed time reads in seconds, minutes, and hours', () => {
    const now = 1_000_000_000
    expect(elapsedOf(now - 3_000, now)).toBe('3s')
    expect(elapsedOf(now - 90_000, now)).toBe('1m')
    expect(elapsedOf(now - 3_600_000, now)).toBe('1h')
    expect(elapsedOf(now + 3_000, now)).toBe('0s')
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
    expect(pressed?.textContent).toBe('Chat')
    fireEvent.click(container.querySelector('button[data-lens="timeline"]') as Element)
    expect(chosen).toEqual(['timeline'])
    expect([lensFrom('timeline'), lensFrom('waterfall'), lensFrom(null)]).toEqual([
      'timeline',
      'answers',
      'answers',
    ])
  })

  test('the strip hands the pill the place of the option it pressed', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.lens === 'timeline' ? 62 : 2
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 60)
    try {
      const [lens, setLens] = createSignal<Lens>('answers')
      const { container } = render(() => <LensSwitch lens={lens()} onChoose={setLens} />)
      const strip = container.querySelector('.lens') as HTMLElement

      expect(strip.style.getPropertyValue('--pick-x')).toBe('2px')
      expect(strip.style.getPropertyValue('--pick-w')).toBe('60px')

      fireEvent.click(container.querySelector('button[data-lens="timeline"]') as Element)

      expect(strip.style.getPropertyValue('--pick-x')).toBe('62px')
      expect(strip.style.getPropertyValue('--pick-w')).toBe('60px')
    } finally {
      vi.restoreAllMocks()
    }
  })

  test('the tab strip hands the underline the place of the tab it shows', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.id === 'run' ? 62 : 2
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 40)
    try {
      const { store, setState } = makeStore({ pane: { kind: 'changes', path: undefined } })
      const { container } = render(() => <ContextPane store={store} />)
      const strip = container.querySelector('.tabs') as HTMLElement

      expect(strip.style.getPropertyValue('--tab-x')).toBe('2px')
      expect(strip.style.getPropertyValue('--tab-w')).toBe('40px')

      setState((current) => ({ ...current, pane: { kind: 'run' } }))

      expect(strip.style.getPropertyValue('--tab-x')).toBe('62px')
      expect(strip.style.getPropertyValue('--tab-w')).toBe('40px')
    } finally {
      vi.restoreAllMocks()
    }
  })

  test('the pill slides only while motion is welcome, and stays put under reduce', () => {
    const sheet = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../style.css'),
      'utf8',
    )
    const motion = sheet.indexOf('@media (prefers-reduced-motion: no-preference)')
    expect(motion).toBeGreaterThan(-1)
    const end = sheet.indexOf('\n}', motion)
    const quiet = sheet.slice(0, motion) + sheet.slice(end)
    expect(sheet.slice(motion, end)).toMatch(
      /\.lens::before \{[^}]*transition:[^}]*transform 160ms ease-out/,
    )
    expect(quiet).not.toMatch(/\.lens::before \{[^}]*transition/)
    // The pill still reads its place without the transition; reduce only drops the motion.
    expect(quiet).toMatch(/\.lens \{[^}]*position: relative/)
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
    expect(container.textContent).toContain('Pages it published remain.')

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

  test('the status bar names the branch its workspace stands on beside the path', () => {
    const { store } = makeStore({
      info: { cwd: '/work/project', model: '', turns: 0, branch: 'feature/status-bar' },
    })
    const { container } = render(() => (
      <Status store={store} drawer={false} onDrawer={() => undefined} />
    ))

    expect(container.querySelector('.where')?.textContent).toBe('/work/project')
    const branch = container.querySelector('.branch')
    expect(branch?.textContent).toBe('feature/status-bar')
    expect(branch?.getAttribute('title')).toBe('git branch feature/status-bar')
  })

  test('the status bar leaves the branch out when the workspace names none', () => {
    const { store } = makeStore({ info: { cwd: '/work/project', model: '', turns: 0 } })
    const { container } = render(() => (
      <Status store={store} drawer={false} onDrawer={() => undefined} />
    ))

    expect(container.querySelector('.where')?.textContent).toBe('/work/project')
    expect(container.querySelector('.branch')).toBeNull()
  })

  /** A run that used 540k of a 1M window, 50k before compaction runs. */
  const usedRun = () => ({
    goal: null,
    schedules: [],
    jobs: [],
    subagents: [],
    todos: [],
    todoCounts: { pending: 0, inProgress: 0, completed: 0 },
    skills: [],
    promptSections: [],
    queued: [],
    steering: [],
    model: 'stub/model',
    effort: '',
    efforts: [],
    usage: {
      total: '371k',
      input: '360k',
      output: '11k',
      turns: 8,
      cache: '94%',
      speed: { text: '42', value: 42 },
      context: { used: '540k', window: '1.0M', left: '50k', share: 0.54, fire: 0.59 },
    },
  })
  const textsAt = (root: ParentNode, selector: string): ReadonlyArray<string | null> =>
    [...root.querySelectorAll(selector)].map((node) => node.textContent)

  test('usage reads in the Run pane, gold within a tenth of compaction, and not in the status bar', () => {
    const { store } = makeStore({ sessionId: 'a', pane: { kind: 'run' }, run: usedRun() })
    const { container } = render(() => <ContextPane store={store} />)
    expect(textsAt(container, '#run-usage .usage-total')).toEqual(['371k tokens'])
    expect(textsAt(container, '.usage-context-of')).toEqual(['540k / 1.0M'])
    expect(textsAt(container, '.usage-context.near .usage-left')).toEqual(['Compacts in 50k'])
    expect(textsAt(container, '.dial-value')).toEqual(['42'])
    const track = container.querySelector('.dial-track')
    const fill = container.querySelector('.dial-fill')
    // The ring keeps one arc and carries the speed in how much of it is drawn,
    // so a new reading can grow the dash instead of swapping the path.
    expect(fill?.getAttribute('d')).toBe(track?.getAttribute('d'))
    expect(fill?.getAttribute('pathLength')).toBe('1')
    expect(fill?.getAttribute('stroke-dasharray')).toBe('0.084 1')
    expect(textsAt(container, '.usage-note')).toEqual(['Cache 94%', '8 turns'])

    const strip = render(() => <Status store={store} drawer={false} onDrawer={() => undefined} />)
    expect(strip.container.textContent).not.toContain('371k')
  })

  test('the ring beside the composer reads the context and opens the Run pane at its usage', async () => {
    const { store, calls } = makeStore({ sessionId: 'a', pane: { kind: 'run' }, run: usedRun() })
    render(() => <ContextPane store={store} />)
    const { container } = render(() => <Composer store={store} />)
    const ring = container.querySelector('#context-ring') as HTMLElement
    expect(ring.textContent).toBe('54%')
    expect(ring.title).toBe('Context 540k / 1.0M · Compacts in 50k')
    // jsdom scrolls nothing, so the scroll the ring asks for is caught here.
    const scrolled = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrolled,
      configurable: true,
    })
    try {
      fireEvent.click(ring)
      expect(calls).toContainEqual({ kind: 'pane', pane: { kind: 'run' } })
      await new Promise((done) => requestAnimationFrame(done))
      expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' })
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  test('usage the log cannot state stays out: no cache line, an empty dial, a dash for its speed', () => {
    const { store } = makeStore({
      sessionId: 'a',
      pane: { kind: 'run' },
      run: {
        goal: null,
        schedules: [],
        jobs: [],
        subagents: [],
        todos: [],
        todoCounts: { pending: 0, inProgress: 0, completed: 0 },
        skills: [],
        promptSections: [],
        queued: [],
        steering: [],
        model: 'stub/model',
        effort: '',
        efforts: [],
        usage: { total: '—', input: '—', output: '—', turns: 0 },
      },
    })
    const { container } = render(() => <ContextPane store={store} />)
    expect(container.querySelector('.dial-value')?.textContent).toBe('—')
    expect(container.querySelector('.dial-fill')).toBeNull()
    expect(container.querySelector('.usage-context')).toBeNull()
    expect([...container.querySelectorAll('.usage-note')].map((note) => note.textContent)).toEqual([
      '0 turns',
    ])
  })

  test('a turn faster than the dial fills the whole ring, and its reading says how fast', () => {
    const { container } = render(() => <SpeedDial speed={{ text: '2100', value: 2100 }} />)
    const ring = (selector: string) => container.querySelector(selector)?.getAttribute('d')
    expect(ring('.dial-fill')).toBe(ring('.dial-track'))
    expect(container.querySelector('.dial-fill')?.getAttribute('stroke-dasharray')).toBe('1 1')
    expect(container.querySelector('.dial-value.long')?.textContent).toBe('2100')
  })

  test('the dial fill eases between lengths, and only while motion is welcome', () => {
    const sheet = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../style.css'),
      'utf8',
    )
    const motion = sheet.indexOf('@media (prefers-reduced-motion: no-preference)')
    expect(motion).toBeGreaterThan(-1)
    const end = sheet.indexOf('\n}', motion)
    const welcome = sheet.slice(motion, end)
    expect(welcome).toMatch(/\.dial-fill \{[^}]*transition: stroke-dasharray 180ms ease-out/)
    // A reader who asked for less motion gets the new length at once.
    expect(sheet.slice(0, motion) + sheet.slice(end)).not.toMatch(/\.dial-fill \{[^}]*transition/)
  })

  test('the status bar says working while a session runs, without counting runners', () => {
    const now = Date.now()
    const running = traceOf([{ seq: 1, time: now, type: 'turn/start', data: { turn: 1 } }])
    const { store } = makeStore(
      {
        connected: true,
        conversation: { ...emptyConversation, running: true },
        sessions: [
          { id: 'aaaabbbb', cwd: '/one/work', createdAt: now, updatedAt: now, title: 'first' },
        ],
      },
      new Map([
        ['aaaabbbb', { conversation: { ...emptyConversation, running: true }, trace: running }],
      ]),
    )

    const { container } = render(() => (
      <Status store={store} drawer={false} onDrawer={() => undefined} />
    ))

    expect(container.querySelector('.hint')?.textContent).toBe('working…')
    expect(container.querySelector('.fleet')).toBeNull()
  })

  test('the status bar keeps the room the pane strip measured', () => {
    // The composer watches its own width too, so each callback is kept by what it observes.
    const measures = new Map<Element, (width: number) => void>()
    class FakeResizeObserver {
      private readonly callback: (
        entries: ReadonlyArray<{ readonly contentRect: { readonly width: number } }>,
      ) => void
      constructor(
        callback: (
          entries: ReadonlyArray<{ readonly contentRect: { readonly width: number } }>,
        ) => void,
      ) {
        this.callback = callback
      }
      observe(element: Element): void {
        measures.set(element, (width) => this.callback([{ contentRect: { width } }]))
      }
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    try {
      const { store } = makeStore()
      const { container } = render(() => <App store={store} />)
      const header = container.querySelector('#status') as HTMLElement
      measures.get(container.querySelector('#context') as Element)?.(221.4)
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

    const alpha = '.recent-group[data-cwd="/work/alpha"] '
    const beta = '.recent-group[data-cwd="/work/beta"] '
    expect(container.querySelectorAll(alpha + '.fold:not([inert]) button.session')).toHaveLength(1)
    expect(
      container.querySelector(alpha + 'button.recent-fold[aria-expanded="true"]'),
    ).not.toBeNull()
    // A folded folder keeps its rows drawn for the fold to close over, out of reach.
    const fold = container.querySelector(beta + '.fold')
    expect(
      container.querySelectorAll(beta + '.fold[data-open="false"] button.session'),
    ).toHaveLength(1)
    expect(fold).toHaveProperty('inert', true)
    const head = container.querySelector(beta + 'button.recent-fold')
    expect(head).toHaveProperty('ariaExpanded', 'false')

    fireEvent.click(head as Element)

    expect(fold).toHaveProperty('inert', false)
    expect(container.querySelector(beta + '.fold[data-open="true"]')).toBe(fold)
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

  test('Add workspace picks a folder in a dialog in front of the page', async () => {
    const { store, calls, browses } = makeStore({
      workspaces: { cwd: '/work/server', items: [listed('/work/beta', 20)] },
    })

    const { container } = render(() => <Board store={store} />)
    const opener = container.querySelector('.workspace-add-open') as HTMLButtonElement

    fireEvent.click(opener)
    expect(calls).toContainEqual({ kind: 'browseDirectories', path: '' })

    // The dialog stands on the page, not inside the rail the button lives in.
    const dialog = dialogOf()
    expect(dialog.closest('.workspace-pick')).toBeNull()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Add workspace',
    )
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog))
    expect(dialog.querySelector('.workspace-browse-path')?.textContent).toContain('Reading')

    browses[0]?.reply({
      kind: 'listed',
      view: { path: '/work', parent: '/', items: ['/work/alpha', '/work/beta'] },
    })

    const folders = [...dialog.querySelectorAll('.workspace-browse-folder')]
    expect(folders.map((folder) => folder.textContent)).toEqual(['alpha', 'beta'])
    expect(dialog.querySelector('.workspace-browse-path')?.textContent).toContain('/work')

    fireEvent.click(folders[0] as Element)
    expect(calls.at(-1)).toEqual({ kind: 'browseDirectories', path: '/work/alpha' })
    browses[1]?.reply({
      kind: 'listed',
      view: { path: '/work/alpha', parent: '/work', items: [] },
    })

    fireEvent.click(dialog.querySelector('.workspace-browse-use') as Element)
    expect(calls).toContainEqual({ kind: 'addWorkspace', cwd: '/work/alpha' })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
  })

  test('a folder the dialog cannot read says why and adds nothing', () => {
    const { store, calls, browses } = makeStore({
      workspaces: { cwd: '/work/server', items: [listed('/work/beta', 20)] },
    })

    const { container } = render(() => <Board store={store} />)

    fireEvent.click(container.querySelector('.workspace-add-open') as Element)
    browses[0]?.reply({ kind: 'refused', message: 'cannot read this directory' })

    expect(dialogOf().querySelector('[role="alert"]')?.textContent).toContain(
      'cannot read this directory',
    )
    expect(dialogOf().querySelector('.workspace-browse-use')).toBeNull()
    expect(calls.filter((call) => call.kind === 'addWorkspace')).toEqual([])
  })

  test('Escape closes the Add workspace dialog and hands focus back', async () => {
    const { store, calls, browses } = makeStore({
      workspaces: { cwd: '/work/server', items: [listed('/work/beta', 20)] },
    })

    const { container } = render(() => <Board store={store} />)
    const opener = container.querySelector('.workspace-add-open') as HTMLButtonElement

    fireEvent.click(opener)
    browses[0]?.reply({
      kind: 'listed',
      view: { path: '/work', parent: '/', items: ['/work/alpha'] },
    })

    fireEvent.keyDown(dialogOf(), { key: 'Escape' })

    expect(document.querySelector('.workspace-dialog')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
    expect(calls.filter((call) => call.kind === 'addWorkspace')).toEqual([])
  })

  test('a press beside the Add workspace dialog closes it, a press inside does not', async () => {
    const { store, calls, browses } = makeStore({
      workspaces: { cwd: '/work/server', items: [listed('/work/beta', 20)] },
    })

    const { container } = render(() => <Board store={store} />)
    const opener = container.querySelector('.workspace-add-open') as HTMLButtonElement

    fireEvent.click(opener)
    browses[0]?.reply({
      kind: 'listed',
      view: { path: '/work', parent: '/', items: ['/work/alpha'] },
    })

    const dialog = dialogOf()
    fireEvent.pointerDown(dialog)
    expect(document.querySelector('.workspace-dialog')).not.toBeNull()

    const backdrop = document.querySelector('.workspace-dialog-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.pointerDown(backdrop as Element)

    expect(document.querySelector('.workspace-dialog')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
    expect(calls.filter((call) => call.kind === 'addWorkspace')).toEqual([])
  })

  test('Tab stays inside the Add workspace dialog', () => {
    const { store, browses } = makeStore({
      workspaces: { cwd: '/work/server', items: [listed('/work/beta', 20)] },
    })

    const { container } = render(() => <Board store={store} />)

    fireEvent.click(container.querySelector('.workspace-add-open') as Element)

    // While the folders are still arriving the dialog itself holds the keys.
    const dialog = dialogOf()
    dialog.focus()
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(dialog)

    browses[0]?.reply({
      kind: 'listed',
      view: { path: '/work', parent: '/', items: ['/work/alpha'] },
    })

    const up = dialog.querySelector('.workspace-browse-up') as HTMLButtonElement
    const cancel = dialog.querySelector('.workspace-browse-cancel') as HTMLButtonElement

    up.focus()
    expect(fireEvent.keyDown(up, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(cancel)

    expect(fireEvent.keyDown(cancel, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(up)
  })
})

describe('the pour', () => {
  test('a rising level starts from how long the work has run, never from the future', () => {
    expect(pourFrom(1_000, 4_500)).toBe('-3.5s')
    expect(pourFrom(5_000, 4_000)).toBe('0s')
  })
})

describe('the finish the reader has seen', () => {
  test('a finish stays fresh until the reader has had its session open and left it', () => {
    localStorage.removeItem(SEEN_KEY)
    let clock = 1_000
    const [open, setOpen] = createSignal('')
    const seen = createRoot(() => createSeen(open, () => clock))
    // What ended before this browser first kept count is not news.
    expect(seen.fresh('a', 500)).toBe(false)
    expect(seen.fresh('a', 2_000)).toBe(true)

    clock = 3_000
    setOpen('a')
    expect(seen.fresh('a', 2_000)).toBe(false)
    // A turn that ends while the reader is on it stays green until they move on.
    expect(seen.fresh('a', 4_000)).toBe(true)

    clock = 5_000
    setOpen('b')
    expect(seen.fresh('a', 4_000)).toBe(false)
    expect(looksFrom(localStorage.getItem(SEEN_KEY), 0)).toEqual({
      since: 1_000,
      at: { a: 5_000, b: 5_000 },
    })
    expect(looksFrom('not json', 7)).toEqual({ since: 7, at: {} })
    expect(looksFrom('{"since":"x"}', 7)).toEqual({ since: 7, at: {} })
  })
})
