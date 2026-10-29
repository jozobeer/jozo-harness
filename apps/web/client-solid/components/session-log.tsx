import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { dataText, type LogEvent, type LogNode } from '../../src/ui/log.ts'
import { useTranslate } from '../i18n.ts'
import type { SessionStore } from '../store.ts'
import { Icon } from './ui/icon.tsx'

/** One row's height. The list draws only the rows the viewport holds, so a long log costs no more than a short one. */
const ROW = 28
/** Rows drawn beyond either edge, so a flick of the wheel lands on rows that already exist. */
const OVERSCAN = 8

const timeOf = (time: number): string =>
  new Date(time).toLocaleTimeString(undefined, { hour12: false })

/** True when the event's type or any key of its body names the filter word. */
const matches = (event: LogEvent, query: string): boolean =>
  query === '' ||
  event.type.toLowerCase().includes(query) ||
  event.keys.some((key) => key.toLowerCase().includes(query))

/** True when a marked conversation element is the node the event grew. */
const matchesNode = (element: HTMLElement, node: LogNode): boolean => {
  // A call's id is unique in the log, and the card may sit outside the step it grew in.
  if (node.callId !== undefined) return element.dataset['callId'] === node.callId
  if (element.dataset['turn'] !== String(node.turn)) return false
  return node.step === undefined || element.dataset['step'] === String(node.step)
}

/**
 * Moves the page to the conversation node an event grew. The chat lens is
 * chosen first because the timeline draws the same work in another shape, and
 * the node is marked so the reader can find it in a long column. Nothing here
 * writes to the log or asks the model for anything.
 */
export const revealNode = (node: LogNode, root: ParentNode = document): HTMLElement | undefined => {
  const chat = root.querySelector<HTMLButtonElement>('.lens-option[data-lens="answers"]')
  if (chat !== null && chat.getAttribute('aria-pressed') !== 'true') chat.click()
  const found = [...root.querySelectorAll<HTMLElement>('[data-turn], [data-call-id]')].find(
    (element) => matchesNode(element, node),
  )
  if (found === undefined) return undefined
  // A step inside a folded process is not on screen until the process is open.
  found.closest('details')?.setAttribute('open', '')
  found.classList.remove('revealed')
  // Reading the layout restarts the mark when the same node is asked for twice.
  void found.offsetWidth
  found.classList.add('revealed')
  if (typeof found.scrollIntoView === 'function') found.scrollIntoView({ block: 'center' })
  return found
}

/**
 * The session's raw log beside the conversation. A row is one event with the
 * seq and type the log wrote; the selected row opens the folded body and the
 * node it grew. The pane reads only: selecting a row changes which pane the
 * page shows, never the event or the model's next turn.
 */
export const SessionLog = (props: { store: SessionStore; seq: number | undefined }) => {
  const t = useTranslate()
  const [query, setQuery] = createSignal('')
  const [top, setTop] = createSignal(0)
  const [height, setHeight] = createSignal(ROW * 12)
  let list: HTMLDivElement | undefined

  const events = (): ReadonlyArray<LogEvent> => props.store.state().log.events
  const shown = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return events().filter((event) => matches(event, needle))
  })
  /** The first row the viewport holds, clamped when a filter leaves fewer rows. */
  const start = (): number => {
    const first = Math.floor(top() / ROW) - OVERSCAN
    const last = Math.max(0, shown().length - 1)
    return Math.min(Math.max(0, first), last)
  }
  const count = (): number => Math.ceil(height() / ROW) + OVERSCAN * 2
  const windowed = (): ReadonlyArray<LogEvent> => shown().slice(start(), start() + count())
  const selected = (): LogEvent | undefined => events().find((event) => event.seq === props.seq)

  const nodeLabel = (node: LogNode): string => {
    const parts = [t('log.turn') + String(node.turn)]
    if (node.step !== undefined) parts.push(t('log.step') + String(node.step))
    if (node.callId !== undefined) parts.push(t('log.call') + node.callId)
    return parts.join(' · ')
  }

  onMount(() => {
    const measure = (): void => {
      if (list !== undefined && list.clientHeight > 0) setHeight(list.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (list !== undefined) observer.observe(list)
    onCleanup(() => observer.disconnect())
  })

  return (
    <section class="session-log" aria-label={t('log.title')}>
      <header class="log-head">
        <div class="log-head-line">
          <h2 class="pane-title">{t('log.title')}</h2>
          <span class="log-count">{String(shown().length) + ' / ' + String(events().length)}</span>
        </div>
        <label class="log-filter">
          <Icon name="search" />
          <input
            type="search"
            value={query()}
            placeholder={t('log.filter')}
            aria-label={t('log.filter')}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setTop(0)
              if (list !== undefined) list.scrollTop = 0
            }}
          />
        </label>
        <p class="log-note">{t('log.readonly')}</p>
      </header>
      <div
        class="log-list"
        ref={(element) => {
          list = element
        }}
        onScroll={(event) => setTop(event.currentTarget.scrollTop)}
      >
        <div class="log-rows" style={{ height: String(shown().length * ROW) + 'px' }}>
          <For each={windowed()}>
            {(event, index) => (
              <button
                class={'log-row' + (props.seq === event.seq ? ' selected' : '')}
                type="button"
                data-seq={String(event.seq)}
                style={{ top: String((start() + index()) * ROW) + 'px' }}
                onClick={() => props.store.showPane({ kind: 'log', seq: event.seq })}
              >
                <span class="log-row-seq">{String(event.seq)}</span>
                <span class="log-row-type">{event.type}</span>
                <span class="log-row-time">{timeOf(event.time)}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={shown().length === 0}>
          <p class="log-empty">{t('log.empty')}</p>
        </Show>
      </div>
      <Show when={selected()} fallback={<p class="log-empty">{t('log.none')}</p>}>
        {(event) => (
          <section class="log-detail" aria-label={t('log.data')}>
            <header class="log-detail-head">
              <span class="log-seq">{'#' + String(event().seq)}</span>
              <span class="log-type">{event().type}</span>
              <span class="log-time">{timeOf(event().time)}</span>
              <Show when={event().node}>
                {(node) => (
                  <button class="log-reveal" type="button" onClick={() => revealNode(node())}>
                    <Icon name="answers" />
                    {nodeLabel(node())}
                  </button>
                )}
              </Show>
            </header>
            <pre class="log-data">{dataText(event().data)}</pre>
          </section>
        )}
      </Show>
    </section>
  )
}
