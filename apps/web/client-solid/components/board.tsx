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
import type { SessionSummary } from '../../src/shared/rpc.ts'
import { boardOf, type BoardEntry, type Waiting } from '../../src/ui/board.ts'
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

/** The row that opens a session; every session shows exactly one. */
const Row = (props: { entry: BoardEntry; store: SessionStore; detail: string }) => (
  <button
    class={
      'session ' +
      props.entry.status +
      (props.entry.summary.id === props.store.state().sessionId ? ' active' : '')
    }
    type="button"
    // The folder a row belongs to is on hover until the workspaces group the rail.
    title={basenameOf(props.entry.summary.cwd)}
    data-session-id={props.entry.summary.id}
    onClick={() => props.store.moveTo(props.entry.summary.id)}
  >
    <span class="session-mark" />
    <span class="session-name">{titleOf(props.entry)}</span>
    <span class="session-detail">{props.detail}</span>
  </button>
)

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
  const board = createMemo(() =>
    boardOf(matching(props.store.state().sessions, query()), props.store.watched()),
  )
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
