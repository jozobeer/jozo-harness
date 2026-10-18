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
import { boardOf, visibleSessions, type BoardEntry, type Waiting } from '../../src/ui/board.ts'
import { basenameOf, whenOf } from '../lib.ts'
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
  const now = createNow()
  return (
    <>
      <div class="brand">jozo-harness</div>
      <Button
        id="new-session"
        variant="quiet"
        type="button"
        onClick={() => props.store.moveTo(undefined)}
      >
        + New session
      </Button>
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
          <For each={board().rest}>
            {(entry) => <Row entry={entry} store={props.store} detail={restDetail(entry, now())} />}
          </For>
        </Section>
        <Show when={noMatch()}>
          <p class="board-empty">No sessions match “{query().trim()}”.</p>
        </Show>
      </nav>
    </>
  )
}
