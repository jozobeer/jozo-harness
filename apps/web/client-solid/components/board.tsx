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
import { Portal } from 'solid-js/web'
import { plainText } from '@jozo-harness/ui-view'
import { Linkify } from './linkify.tsx'
import type { DirectoryView, SessionAction, SessionSummary } from '../../src/shared/rpc.ts'
import {
  RECENT_PAGE,
  atKey,
  boardOf,
  byKey,
  keysOf,
  recentGroupsOf,
  visibleSessions,
  type BoardEntry,
  type RecentGroup,
  type Waiting,
} from '../../src/ui/board.ts'
import { basenameOf, whenOf } from '../lib.ts'
import { RECENT_FOLDED_KEY, RECENT_SHOWN_KEY, keepPaths, pathsFrom } from '../recent.ts'
import { useSeen } from '../seen.ts'
import type { BrowseAnswer, SessionStore } from '../store.ts'
import { Button } from './ui/button.tsx'
import { Fizz } from './ui/fizz.tsx'
import { EndMark } from './ui/end-mark.tsx'
import { Icon } from './ui/icon.tsx'
import { Mug } from './ui/mug.tsx'

/** The clock the rows read; one tick a second. */
const createNow = () => {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}

const titleOf = (entry: BoardEntry): string =>
  entry.summary.title === '' ? entry.summary.id.slice(0, 8) : entry.summary.title

/** What the row menu can say about a copy: nothing yet, or how it went. */
type Copied = 'idle' | 'copied' | 'failed'

/** Hands the whole id to the page's clipboard; an insecure page has none to give. */
const copyId = async (id: string): Promise<Copied> => {
  try {
    await navigator.clipboard.writeText(id)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/** The menu item's label, which reports the try once the reader has made one. */
const copyLabel = (copied: Copied): string =>
  copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy session ID'

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
    <div class="session-search-field">
      <Icon name="search" class="session-search-icon" />
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
    </div>
  )
}

/**
 * How a row stands at a glance: a mug filling while it works, else how its last
 * turn ended. A row that waits on you sits in a glass already, so it wears none.
 */
const SessionMark = (props: { entry: BoardEntry }) => {
  const seen = useSeen()
  const fresh = (): boolean => {
    const ended = props.entry.ended
    return ended !== undefined && seen.fresh(props.entry.summary.id, ended.at)
  }
  return (
    <Show
      when={props.entry.status === 'running'}
      fallback={
        <EndMark outcome={props.entry.ended?.outcome} fresh={fresh()} class="session-mark" />
      }
    >
      <Mug state="filling" since={props.entry.since} />
    </Show>
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
  const [copied, setCopied] = createSignal<Copied>('idle')

  const close = (): void => {
    setMenu(false)
    setRenaming(false)
    setConfirming(false)
    setCopied('idle')
  }
  const open = (): void => {
    setConfirming(false)
    setRenaming(false)
    setMenu(true)
    setCopied('idle')
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
  const copySessionId = (): void => {
    // The menu stays open so the label can report whether the copy landed.
    void copyId(id()).then((state) => setCopied(state))
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
          <Show when={props.entry.status !== 'waiting'}>
            <SessionMark entry={props.entry} />
          </Show>
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
          <button class="session-menu-item" type="button" onClick={copySessionId}>
            {copyLabel(copied())}
          </button>
          <Show when={copied() === 'failed'}>
            <span class="session-id-fallback">{id()}</span>
          </Show>
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
              variant="foam"
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
              variant="rim"
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
                  variant="scoop"
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
        <Fizz />
        <Row
          entry={props.entry}
          store={props.store}
          detail={waiting().kind === 'approval' ? 'approval' : 'question'}
        />
        <p class="board-asked">
          <Linkify text={askedOf(waiting())} />
        </p>
        <Answer entry={props.entry} waiting={waiting()} store={props.store} />
      </div>
    )}
  </Show>
)

const Section = (props: {
  title: string
  icon: JSX.Element
  count: number
  children: JSX.Element
}) => (
  <Show when={props.count > 0}>
    <section class="board-section">
      <h2 class="board-title">
        {props.icon}
        {props.title}
        <span class="board-count">{String(props.count)}</span>
      </h2>
      {props.children}
    </section>
  </Show>
)

/** The mark says how a session stands; the same cell says when it last did. */
const restDetail = (entry: BoardEntry, now: number): string => whenOf(entry.since, now)

/**
 * One workspace of Recent. Its header folds the folder; Show more draws the rows
 * past the first page. The folder holding the open session stays open, however
 * the reader left it, so the session on screen never hides behind a fold.
 */
const RecentFolder = (props: {
  group: RecentGroup
  /** Every row the board built, so a row is found by the key it keeps. */
  rows: ReadonlyMap<string, BoardEntry>
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
        <span class="recent-name">{basenameOf(props.group.cwd)}</span>
        <span class="recent-count">{String(props.group.entries.length)}</span>
        <Icon name="chevron-down" class="recent-chevron" />
      </button>
      {/* The rows stay drawn while folded, so the fold can close over them; inert keeps them out of reach. */}
      <div class="fold" data-open={String(!folded())} inert={folded()}>
        <div class="fold-body">
          <For each={keysOf(rows(), (entry) => entry.summary.id)}>
            {(id) => {
              const entry = () => atKey(props.rows, id)
              return (
                <Row entry={entry()} store={props.store} detail={restDetail(entry(), props.now)} />
              )
            }}
          </For>
          <Show when={more() && !all()}>
            <button
              class="recent-more"
              type="button"
              onClick={() => props.onShown(props.group.cwd)}
            >
              Show more
            </button>
          </Show>
          <Show when={more() && expanded() && !open()}>
            <button
              class="recent-more"
              type="button"
              onClick={() => props.onShown(props.group.cwd)}
            >
              Show less
            </button>
          </Show>
        </div>
      </div>
    </section>
  )
}

/**
 * The folder a new session starts in. The list arrives newest use first, so the
 * first option is the last folder used; Add workspace opens a folder dialog in
 * front of the page, registers the folder chosen there, and the picker reads the
 * list again.
 */
const WorkspacePicker = (props: { store: SessionStore }) => {
  const [choice, setChoice] = createSignal('')
  const [browsing, setBrowsing] = createSignal(false)
  const [folder, setFolder] = createSignal<DirectoryView | undefined>()
  const [browseProblem, setBrowseProblem] = createSignal('')
  // Each click on a folder makes the answer to the one before it stale.
  let asked = 0
  let addButton: HTMLButtonElement | undefined
  let dialog: HTMLDivElement | undefined
  const listed = () => props.store.state().workspaces
  const folders = () => listed()?.items ?? []
  const value = (): string => {
    const items = folders()
    const chosen = choice()
    if (chosen !== '' && items.some((item) => item.cwd === chosen)) return chosen
    return items[0]?.cwd ?? listed()?.cwd ?? ''
  }
  const heard = (answer: BrowseAnswer): void => {
    if (answer.kind === 'listed') {
      setFolder(answer.view)
      setBrowseProblem('')
      return
    }
    setBrowseProblem(answer.message)
  }
  const browse = (path: string): void => {
    const turn = ++asked
    props.store.browseDirectories(path, (answer) => {
      if (turn === asked) heard(answer)
    })
  }
  const openBrowser = (): void => {
    setBrowsing(true)
    setBrowseProblem('')
    setFolder(undefined)
    browse('')
    // The page behind the dialog gives up the keys once the dialog is drawn.
    queueMicrotask(() => dialog?.focus())
  }
  const closeBrowser = (): void => {
    setBrowsing(false)
    setBrowseProblem('')
    setFolder(undefined)
    // A dialog that vanishes leaves the keys nowhere; its button takes them back.
    addButton?.focus()
  }
  /** The controls Tab can reach inside the dialog, in the order it reaches them. */
  const focusables = (): ReadonlyArray<HTMLElement> => {
    if (dialog === undefined) return []
    return [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ]
  }
  /** Keeps Tab inside the dialog, wrapping at the ends of its controls. */
  const tabKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return
    const items = focusables()
    const first = items[0]
    const last = items[items.length - 1]
    if (first === undefined || last === undefined) {
      // Loading or refused: no control to step to, so the dialog keeps the keys.
      event.preventDefault()
      dialog?.focus()
      return
    }
    const backwards = event.shiftKey
    const edge = backwards ? first : last
    if (document.activeElement !== edge) return
    event.preventDefault()
    if (backwards) last.focus()
    else first.focus()
  }
  const holdKeys = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeBrowser()
      return
    }
    tabKey(event)
  }
  const addFolder = (): void => {
    const cwd = folder()?.path
    if (cwd === undefined) return
    props.store.addWorkspace(cwd)
    closeBrowser()
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
        <Icon name="plus" />
        New session
      </Button>
      <Button
        class="workspace-add-open"
        variant="quiet"
        type="button"
        ref={(node) => {
          addButton = node
        }}
        onClick={openBrowser}
      >
        <Icon name="folder" />
        Add workspace
      </Button>
      <Show when={browsing()}>
        <Portal>
          <div
            class="workspace-dialog-backdrop"
            onPointerDown={(event) => {
              // Only the backdrop itself: a press that starts inside the dialog
              // and ends outside it is a slip, not a dismissal.
              if (event.target === event.currentTarget) closeBrowser()
            }}
          >
            <div
              class="workspace-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="workspace-dialog-title"
              tabindex="-1"
              ref={(node) => {
                dialog = node
              }}
              onKeyDown={holdKeys}
            >
              <h2 class="workspace-dialog-title" id="workspace-dialog-title">
                Add workspace
              </h2>
              <p class="workspace-browse-path" title={folder()?.path}>
                {folder()?.path ?? 'Reading folders…'}
              </p>
              <Show when={browseProblem() !== ''}>
                <p class="workspace-browse-error" role="alert">
                  {browseProblem()}
                </p>
              </Show>
              <Show when={folder()}>
                {(view) => (
                  <>
                    <div class="workspace-browse-list">
                      <Show when={view().parent !== null}>
                        <button
                          class="workspace-browse-up"
                          type="button"
                          onClick={() => browse(view().parent ?? '')}
                        >
                          ↑ Up
                        </button>
                      </Show>
                      <For each={view().items}>
                        {(path) => (
                          <button
                            class="workspace-browse-folder"
                            type="button"
                            title={path}
                            onClick={() => browse(path)}
                          >
                            {basenameOf(path)}
                          </button>
                        )}
                      </For>
                      <Show when={view().items.length === 0}>
                        <p class="workspace-browse-empty">No folders here</p>
                      </Show>
                    </div>
                    <div class="workspace-browse-actions">
                      <Button
                        class="workspace-browse-use"
                        variant="primary"
                        type="button"
                        onClick={addFolder}
                      >
                        Use this folder
                      </Button>
                      <Button
                        class="workspace-browse-cancel"
                        variant="quiet"
                        type="button"
                        onClick={closeBrowser}
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
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
  // The rail keys its rows by session and its folders by cwd, so a row whose
  // facts change is found again instead of drawn from scratch: <For> compares
  // the keys, and the row's own reads keep it current.
  const rows = createMemo(() =>
    byKey([...board().waiting, ...board().running, ...board().rest], (entry) => entry.summary.id),
  )
  // A running session keeps its place in Recent too: moving it to a section of
  // its own made the rail jump on every turn.
  const recentEntries = createMemo(() => [...board().rest, ...board().running])
  const recent = createMemo(() => recentGroupsOf(recentEntries()))
  const folders = createMemo(() => byKey(recent(), (group) => group.cwd))
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
        <Section title="Waiting on you" icon={<Mug state="full" />} count={board().waiting.length}>
          <For each={keysOf(board().waiting, (entry) => entry.summary.id)}>
            {(id) => <WaitingCard entry={atKey(rows(), id)} store={props.store} />}
          </For>
        </Section>
        <Section title="Recent" icon={<Icon name="clock" />} count={recentEntries().length}>
          <For each={keysOf(recent(), (group) => group.cwd)}>
            {(cwd) => (
              <RecentFolder
                group={atKey(folders(), cwd)}
                rows={rows()}
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
