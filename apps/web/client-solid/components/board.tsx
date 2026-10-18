import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { plainText } from '@jozo-harness/ui-view'
import type { SessionAction, SessionSummary } from '../../src/shared/rpc.ts'
import {
  RECENT_PAGE,
  boardOf,
  recentGroupsOf,
  visibleSessions,
  type BoardEntry,
  type RecentGroup,
  type Waiting,
} from '../../src/ui/board.ts'
import { basenameOf, whenOf } from '../lib.ts'
import { RECENT_FOLDED_KEY, RECENT_SHOWN_KEY, keepPaths, pathsFrom } from '../recent.ts'
import type { SessionStore } from '../store.ts'
import { Button } from './ui/button.tsx'

/** A span the way the board says it: 38s, 6m, 2h. */
const elapsedOf = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return String(seconds) + 's'
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? String(minutes) + 'm' : String(Math.floor(minutes / 60)) + 'h'
}

/** The clock the running rows read; one tick a second. */
const createNow = () => {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}

const titleOf = (entry: BoardEntry): string =>
  entry.summary.title === '' ? entry.summary.id.slice(0, 8) : entry.summary.title

/** The sessions whose title or folder says what was typed, ignoring case. */
const matching = (
  sessions: ReadonlyArray<SessionSummary>,
  query: string,
): ReadonlyArray<SessionSummary> => {
  const needle = query.trim().toLowerCase()
  if (needle === '') return sessions
  return sessions.filter(
    (session) =>
      session.title.toLowerCase().includes(needle) || session.cwd.toLowerCase().includes(needle),
  )
}

/** Mod+K opens the field from anywhere, even while another field has the keys. */
const searchCombo = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'

/** A bare / opens the field, as long as the page is not already taking the keys. */
const searchSlash = (event: KeyboardEvent): boolean =>
  event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey

const inField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, select, [contenteditable="true"]') !== null

/** The field that narrows the rail: / or Mod+K opens it, Escape empties it. */
const Search = (props: { query: string; onQuery: (query: string) => void }) => {
  let field: HTMLInputElement | undefined
  const open = (): void => {
    field?.focus()
    field?.select()
  }
  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (searchCombo(event)) {
        event.preventDefault()
        open()
        return
      }
      if (!searchSlash(event) || inField(event.target)) return
      event.preventDefault()
      open()
    }
    document.addEventListener('keydown', onKey)
    onCleanup(() => document.removeEventListener('keydown', onKey))
  })
  return (
    <input
      id="session-search"
      class="session-search"
      type="search"
      placeholder="Search sessions…"
      aria-label="Search sessions"
      value={props.query}
      ref={(node) => {
        field = node
      }}
      onInput={(event) => props.onQuery(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        props.onQuery('')
        event.currentTarget.blur()
      }}
    />
  )
}

/**
 * The row that opens a session; every session shows exactly one. Hovering or
 * right-clicking offers the menu that renames, pins, archives, or deletes it;
 * a double-click puts the name itself in reach.
 */
const Row = (props: { entry: BoardEntry; store: SessionStore; detail: string }) => {
  const id = () => props.entry.summary.id
  const pinned = () => props.entry.summary.pinned === true
  const archived = () => props.entry.summary.archived === true
  let row: HTMLDivElement | undefined
  const [menu, setMenu] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  const [draft, setDraft] = createSignal('')

  const close = (): void => {
    setMenu(false)
    setRenaming(false)
    setConfirming(false)
  }
  const open = (): void => {
    setConfirming(false)
    setRenaming(false)
    setMenu(true)
  }
  const act = (action: SessionAction): void => {
    props.store.act(id(), action)
    close()
  }
  const askRename = (): void => {
    setDraft(titleOf(props.entry))
    setMenu(false)
    setConfirming(false)
    setRenaming(true)
  }
  const commitRename = (): void => {
    const title = draft().trim()
    if (title !== '') act({ kind: 'rename', title })
    else close()
  }

  onMount(() => {
    // A menu that stays open when the reader looks elsewhere covers the rail.
    const onPointer = (event: PointerEvent): void => {
      if (row === undefined || !(event.target instanceof Node)) return
      if (!row.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', onPointer)
    onCleanup(() => document.removeEventListener('pointerdown', onPointer))
  })

  return (
    <div
      class="session-row"
      ref={(node) => {
        row = node
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        open()
      }}
    >
      <Show
        when={!renaming()}
        fallback={
          <input
            class="session-rename"
            aria-label="Session name"
            value={draft()}
            ref={(node) => {
              queueMicrotask(() => {
                node.focus()
                node.select()
              })
            }}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRename()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
            onBlur={() => {
              if (renaming()) commitRename()
            }}
          />
        }
      >
        <button
          class={
            'session ' +
            props.entry.status +
            (pinned() ? ' pinned' : '') +
            (archived() ? ' archived' : '') +
            (id() === props.store.state().sessionId ? ' active' : '')
          }
          type="button"
          // The folder a row belongs to is on hover until the workspaces group the rail.
          title={basenameOf(props.entry.summary.cwd)}
          data-session-id={id()}
          onClick={() => props.store.moveTo(id())}
          onDblClick={(event) => {
            event.preventDefault()
            askRename()
          }}
        >
          <span class="session-mark" />
          <span class="session-name">{titleOf(props.entry)}</span>
          <span class="session-detail">{props.detail}</span>
        </button>
      </Show>
      <button
        class="session-menu"
        type="button"
        aria-label="Session actions"
        aria-expanded={menu()}
        onClick={() => {
          if (menu()) close()
          else open()
        }}
      >
        ⋯
      </button>
      <Show when={menu()}>
        <div class="session-menu-panel" role="menu">
          <button class="session-menu-item" type="button" onClick={askRename}>
            Rename
          </button>
          <button
            class="session-menu-item"
            type="button"
            onClick={() => act({ kind: 'pin', pinned: !pinned() })}
          >
            {pinned() ? 'Unpin' : 'Pin'}
          </button>
          <button
            class="session-menu-item"
            type="button"
            onClick={() => act({ kind: 'archive', archived: !archived() })}
          >
            {archived() ? 'Unarchive' : 'Archive'}
          </button>
          <button
            class="session-menu-item danger"
            type="button"
            onClick={() => {
              setMenu(false)
              setConfirming(true)
            }}
          >
            Delete
          </button>
        </div>
      </Show>
      <Show when={confirming()}>
        <div
          class="session-menu-panel session-confirm"
          role="alertdialog"
          aria-label="Delete session"
        >
          <p class="session-confirm-asked">Delete this session?</p>
          <p class="session-confirm-hint">Its log is removed. This cannot be undone.</p>
          <div class="session-confirm-actions">
            <button
              class="session-delete-confirm"
              type="button"
              onClick={() => act({ kind: 'delete' })}
            >
              Delete permanently
            </button>
            <button class="session-delete-cancel" type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

/** The way to answer, right on the board; the session on screen is answered below. */
const Answer = (props: { entry: BoardEntry; waiting: Waiting; store: SessionStore }) => {
  const id = () => props.entry.summary.id
  return (
    <Switch>
      <Match when={id() === props.store.state().sessionId}>
        <div class="card-hint">answer it under the conversation</div>
      </Match>
      <Match when={props.waiting.kind === 'approval' ? props.waiting.request : undefined}>
        {(request) => (
          <div class="board-actions">
            <Button
              variant="primary"
              type="button"
              onClick={() =>
                props.store.sendTo(id(), {
                  kind: 'approve',
                  callId: request().callId,
                  approved: true,
                })
              }
            >
              Allow
            </Button>
            <Button
              type="button"
              onClick={() =>
                props.store.sendTo(id(), {
                  kind: 'approve',
                  callId: request().callId,
                  approved: false,
                })
              }
            >
              Deny
            </Button>
          </div>
        )}
      </Match>
      <Match when={props.waiting.kind === 'ask' ? props.waiting.request : undefined}>
        {(request) => (
          <div class="board-actions">
            <For each={request().options}>
              {(option) => (
                <Button
                  type="button"
                  onClick={() =>
                    props.store.sendTo(id(), { kind: 'answer', id: request().id, answer: option })
                  }
                >
                  {plainText(option)}
                </Button>
              )}
            </For>
          </div>
        )}
      </Match>
    </Switch>
  )
}

const askedOf = (waiting: Waiting): string =>
  waiting.kind === 'approval'
    ? 'Approve ' + waiting.request.tool + '? ' + waiting.request.reason
    : (plainText(waiting.request.question).split('\n')[0] ?? '')

/** A session that waits on the reader: what it asks, and the buttons that answer it. */
const WaitingCard = (props: { entry: BoardEntry; store: SessionStore }) => (
  <Show when={props.entry.waiting}>
    {(waiting) => (
      <div class="board-card">
        <Row
          entry={props.entry}
          store={props.store}
          detail={waiting().kind === 'approval' ? 'approval' : 'question'}
        />
        <p class="board-asked">{askedOf(waiting())}</p>
        <Answer entry={props.entry} waiting={waiting()} store={props.store} />
      </div>
    )}
  </Show>
)

const Section = (props: { title: string; count: number; children: JSX.Element }) => (
  <Show when={props.count > 0}>
    <section class="board-section">
      <h2 class="board-title">
        {props.title}
        <span class="board-count">{String(props.count)}</span>
      </h2>
      {props.children}
    </section>
  </Show>
)

const runningDetail = (entry: BoardEntry, now: number): string =>
  elapsedOf(now - entry.since) + ' · ' + String(entry.calls) + ' calls'

/** The mark says how a session stands; the same cell says when it last did. */
const restDetail = (entry: BoardEntry, now: number): string => whenOf(entry.since, now)

/**
 * One workspace of Recent. Its header folds the folder; Show more draws the rows
 * past the first page. The folder holding the open session stays open, however
 * the reader left it, so the session on screen never hides behind a fold.
 */
const RecentFolder = (props: {
  group: RecentGroup
  store: SessionStore
  folded: ReadonlySet<string>
  shown: ReadonlySet<string>
  onFold: (cwd: string) => void
  onShown: (cwd: string) => void
  now: number
}) => {
  const open = (): boolean =>
    props.group.entries.some((entry) => entry.summary.id === props.store.state().sessionId)
  const folded = (): boolean => !open() && props.folded.has(props.group.cwd)
  const expanded = (): boolean => props.shown.has(props.group.cwd)
  const all = (): boolean => open() || expanded()
  const more = (): boolean => props.group.entries.length > RECENT_PAGE
  const rows = (): ReadonlyArray<BoardEntry> =>
    all() ? props.group.entries : props.group.entries.slice(0, RECENT_PAGE)
  return (
    <section class="recent-group" data-cwd={props.group.cwd}>
      <button
        class="recent-fold"
        type="button"
        title={props.group.cwd}
        aria-expanded={!folded()}
        aria-disabled={open()}
        onClick={() => {
          if (!open()) props.onFold(props.group.cwd)
        }}
      >
        <span class="recent-caret" aria-hidden="true">
          {folded() ? '▸' : '▾'}
        </span>
        <span class="recent-name">{basenameOf(props.group.cwd)}</span>
        <span class="recent-count">{String(props.group.entries.length)}</span>
      </button>
      <Show when={!folded()}>
        <For each={rows()}>
          {(entry) => (
            <Row entry={entry} store={props.store} detail={restDetail(entry, props.now)} />
          )}
        </For>
        <Show when={more() && !all()}>
          <button class="recent-more" type="button" onClick={() => props.onShown(props.group.cwd)}>
            Show more
          </button>
        </Show>
        <Show when={more() && expanded() && !open()}>
          <button class="recent-more" type="button" onClick={() => props.onShown(props.group.cwd)}>
            Show less
          </button>
        </Show>
      </Show>
    </section>
  )
}

/**
 * The folder a new session starts in. The list arrives newest use first, so the
 * first option is the last folder used; Add workspace registers another one by
 * path, and the picker reads the list again when it lands.
 */
const WorkspacePicker = (props: { store: SessionStore }) => {
  const [choice, setChoice] = createSignal('')
  const [path, setPath] = createSignal('')
  const listed = () => props.store.state().workspaces
  const folders = () => listed()?.items ?? []
  const value = (): string => {
    const items = folders()
    const chosen = choice()
    if (chosen !== '' && items.some((item) => item.cwd === chosen)) return chosen
    return items[0]?.cwd ?? listed()?.cwd ?? ''
  }
  const add = (event: SubmitEvent): void => {
    event.preventDefault()
    const cwd = path().trim()
    if (cwd === '') return
    props.store.addWorkspace(cwd)
    setPath('')
  }
  onMount(() => props.store.askWorkspaces())
  return (
    <div class="workspace-pick">
      <select
        id="workspace"
        class="workspace-select"
        aria-label="Workspace for a new session"
        value={value()}
        onChange={(event) => setChoice(event.currentTarget.value)}
      >
        <Show when={folders().length === 0}>
          <option value={listed()?.cwd ?? ''}>{listed()?.cwd ?? 'No workspace yet'}</option>
        </Show>
        <For each={folders()}>
          {(item) => (
            <option value={item.cwd}>
              {basenameOf(item.cwd)} — {item.cwd}
            </option>
          )}
        </For>
      </select>
      <Button
        id="new-session"
        variant="quiet"
        type="button"
        onClick={() => props.store.moveTo(undefined, value() === '' ? undefined : value())}
      >
        + New session
      </Button>
      <details class="workspace-add">
        <summary>Add workspace</summary>
        <form onSubmit={add}>
          <input
            id="workspace-path"
            type="text"
            aria-label="Workspace path"
            placeholder="/path/to/folder"
            value={path()}
            onInput={(event) => setPath(event.currentTarget.value)}
          />
          <Button type="submit" variant="quiet">
            Add
          </Button>
        </form>
      </details>
    </div>
  )
}

/**
 * The cockpit: every session the store holds, sorted by what the reader has to
 * do — answer, watch, or nothing. Sessions the server has open are followed
 * live; the others read as closed until opened.
 */
export const Board = (props: { store: SessionStore }) => {
  const [query, setQuery] = createSignal('')
  const [showArchived, setShowArchived] = createSignal(false)
  const [showEmpty, setShowEmpty] = createSignal(false)
  const archivedCount = createMemo(
    () => props.store.state().sessions.filter((session) => session.archived === true).length,
  )
  const opened = createMemo(() => props.store.state().opened)
  const emptyCount = createMemo(
    () =>
      props.store
        .state()
        .sessions.filter(
          (session) =>
            session.empty === true && session.archived !== true && !opened().includes(session.id),
        ).length,
  )
  const visible = createMemo(() =>
    visibleSessions(props.store.state().sessions, {
      showArchived: showArchived(),
      showEmpty: showEmpty(),
      opened: opened(),
    }),
  )
  const board = createMemo(() => boardOf(matching(visible(), query()), props.store.watched()))
  const noMatch = (): boolean =>
    query().trim() !== '' &&
    board().waiting.length + board().running.length + board().rest.length === 0
  const [foldedFolders, setFoldedFolders] = createSignal(
    pathsFrom(localStorage.getItem(RECENT_FOLDED_KEY)),
  )
  const [shownFolders, setShownFolders] = createSignal(
    pathsFrom(localStorage.getItem(RECENT_SHOWN_KEY)),
  )
  const toggled = (current: ReadonlySet<string>, cwd: string): ReadonlySet<string> => {
    const next = new Set(current)
    if (next.has(cwd)) next.delete(cwd)
    else next.add(cwd)
    return next
  }
  const foldFolder = (cwd: string): void => {
    const next = toggled(foldedFolders(), cwd)
    setFoldedFolders(next)
    keepPaths(RECENT_FOLDED_KEY, next)
  }
  const showFolder = (cwd: string): void => {
    const next = toggled(shownFolders(), cwd)
    setShownFolders(next)
    keepPaths(RECENT_SHOWN_KEY, next)
  }
  const now = createNow()
  return (
    <>
      <div class="brand">jozo-harness</div>
      <WorkspacePicker store={props.store} />
      <Search query={query()} onQuery={setQuery} />
      <Show when={archivedCount() > 0}>
        <button
          id="show-archived"
          class="show-archived"
          type="button"
          aria-pressed={showArchived()}
          onClick={() => setShowArchived(!showArchived())}
        >
          {showArchived() ? 'Hide archived' : 'Show archived (' + String(archivedCount()) + ')'}
        </button>
      </Show>
      <Show when={emptyCount() > 0}>
        <button
          id="show-empty"
          class="show-archived"
          type="button"
          aria-pressed={showEmpty()}
          onClick={() => setShowEmpty(!showEmpty())}
        >
          {showEmpty() ? 'Hide empty' : 'Show empty (' + String(emptyCount()) + ')'}
        </button>
      </Show>
      <nav id="session-list" aria-label="Sessions">
        <Section title="Waiting on you" count={board().waiting.length}>
          <For each={board().waiting}>
            {(entry) => <WaitingCard entry={entry} store={props.store} />}
          </For>
        </Section>
        <Section title="Running" count={board().running.length}>
          <For each={board().running}>
            {(entry) => (
              <div class="board-running">
                <Row entry={entry} store={props.store} detail={runningDetail(entry, now())} />
                <Show when={entry.doing !== ''}>
                  <p class="board-doing">{entry.doing}</p>
                </Show>
              </div>
            )}
          </For>
        </Section>
        <Section title="Recent" count={board().rest.length}>
          <For each={recentGroupsOf(board().rest)}>
            {(group) => (
              <RecentFolder
                group={group}
                store={props.store}
                folded={foldedFolders()}
                shown={shownFolders()}
                onFold={foldFolder}
                onShown={showFolder}
                now={now()}
              />
            )}
          </For>
        </Section>
        <Show when={noMatch()}>
          <p class="board-empty">No sessions match “{query().trim()}”.</p>
        </Show>
      </nav>
    </>
  )
}
