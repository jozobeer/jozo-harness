import { createSignal, onCleanup, onMount } from 'solid-js'
import { Board } from './components/board.tsx'
import { Composer } from './components/composer.tsx'
import { ContextPane } from './components/context-pane.tsx'
import { Conversation } from './components/conversation.tsx'
import { LensSwitch } from './components/lens-switch.tsx'
import { Status } from './components/status.tsx'
import { Waterfall } from './components/waterfall.tsx'
import { LENS_KEY, lensFrom, type Lens } from './lens.ts'
import {
  RAIL_COLLAPSED_KEY,
  RAIL_KEY,
  RAIL_MAX,
  RAIL_MIN,
  clampRailWidth,
  railCollapsedFrom,
  railStateOf,
  railWidthFrom,
  watchWidth,
} from './rail.ts'
import { createSessionStore, type SessionStore } from './store.ts'

/** How far the arrow keys move the boundary between the rail and the page. */
const KEY_STEP = 8

/** Mod+B folds the rail, as long as a field is not taking the keys. */
const foldCombo = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b'

const inField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, select, [contenteditable="true"]') !== null

/** The width where the rail hands its place to a drawer. */
const NARROW_QUERY = '(max-width: 720px)'

const narrowQueryOf = (): MediaQueryList | undefined =>
  typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : undefined

/** The rail's control says what pressing it does in the rail the page draws. */
const foldLabel = (state: 'open' | 'collapsed'): string =>
  state === 'open' ? 'Hide sessions' : 'Show sessions'

const foldTitle = (state: 'open' | 'collapsed'): string =>
  (state === 'open' ? 'Hide' : 'Show') + ' sessions (Mod+B)'

/** The room the folded pane's strip keeps in the status bar. */
const stripRoom = (width: number): string | undefined =>
  width === 0 ? undefined : '--context-strip-w: ' + String(width) + 'px'

/** The drawer attribute, present only while the drawer is open. */
const drawerAttr = (open: boolean): string | undefined => (open ? '' : undefined)

/** The page: the strip, the board of sessions, the answers or the trace, and the pane. */
export const App = (props: { store?: SessionStore; lens?: Lens }) => {
  const store = props.store ?? createSessionStore()
  const [lens, setLens] = createSignal(props.lens ?? lensFrom(localStorage.getItem(LENS_KEY)))
  const [railWidth, setRailWidth] = createSignal(railWidthFrom(localStorage.getItem(RAIL_KEY)))
  const [folded, setFolded] = createSignal(
    railCollapsedFrom(localStorage.getItem(RAIL_COLLAPSED_KEY)),
  )
  /** Below 720px the rail is a drawer: one state decides whether it is seen. */
  const query = narrowQueryOf()
  const [narrow, setNarrow] = createSignal(query?.matches === true)
  const [drawer, setDrawer] = createSignal(false)
  /** The width of the folded pane's strip, so the status bar keeps clear of it. */
  const [stripWidth, setStripWidth] = createSignal(0)
  let context: HTMLElement | undefined
  const railState = (): 'open' | 'collapsed' => railStateOf(narrow(), folded(), drawer())
  const railOpen = (): boolean => railState() === 'open'
  const choose = (next: Lens): void => {
    setLens(next)
    localStorage.setItem(LENS_KEY, next)
  }
  const widen = (width: number): void => {
    setRailWidth(clampRailWidth(width))
  }
  const keepWidth = (): void => localStorage.setItem(RAIL_KEY, String(railWidth()))
  const fold = (next: boolean): void => {
    setFolded(next)
    localStorage.setItem(RAIL_COLLAPSED_KEY, String(next))
  }
  /** The fold button and Mod+B work whichever rail the page draws. */
  const toggleRail = (): void => {
    if (narrow()) setDrawer(!drawer())
    else fold(!folded())
  }
  /** A drag starts at the boundary and follows the pointer until it lets go. */
  const drag = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = railWidth()
    const move = (next: PointerEvent): void => widen(startWidth + next.clientX - startX)
    const end = (): void => {
      keepWidth()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      delete document.body.dataset.railDrag
    }
    document.body.dataset.railDrag = ''
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }
  /** The boundary is a separator: the arrows walk it, and each step is kept. */
  const resizeKeys = (event: KeyboardEvent): void => {
    const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0
    if (step === 0) return
    event.preventDefault()
    widen(railWidth() + step)
    keepWidth()
  }
  onMount(() => {
    store.start()
    const onKey = (event: KeyboardEvent): void => {
      if (!foldCombo(event) || inField(event.target)) return
      event.preventDefault()
      toggleRail()
    }
    document.addEventListener('keydown', onKey)
    const onNarrow = (event: MediaQueryListEvent): void => {
      setNarrow(event.matches)
    }
    query?.addEventListener('change', onNarrow)
    // The strip sizes itself from its tabs, so its room in the status bar is measured.
    const stopWidth = watchWidth(context, setStripWidth)
    onCleanup(() => {
      document.removeEventListener('keydown', onKey)
      query?.removeEventListener('change', onNarrow)
      stopWidth?.()
      store.stop()
    })
  })
  // Both readings stay mounted, so switching back finds the place and the open steps it left.
  return (
    <>
      <header id="status" aria-live="polite" style={stripRoom(stripWidth())}>
        <button
          id="rail-fold"
          class="rail-fold"
          type="button"
          aria-controls="sidebar"
          aria-expanded={railOpen()}
          aria-label={foldLabel(railState())}
          title={foldTitle(railState())}
          onClick={toggleRail}
        >
          {folded() ? '»' : '«'}
        </button>
        <Status
          store={store}
          drawer={drawer()}
          onDrawer={() => {
            setDrawer(!drawer())
          }}
        />
      </header>
      <div
        id="shell"
        data-rail={railState()}
        data-drawer={drawerAttr(drawer())}
        style={'--rail-w: ' + String(railWidth()) + 'px'}
      >
        <aside id="sidebar">
          <Board store={store} />
        </aside>
        <div
          id="rail-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sessions"
          aria-valuemin={RAIL_MIN}
          aria-valuemax={RAIL_MAX}
          aria-valuenow={railWidth()}
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={resizeKeys}
        />
        <div id="main" data-lens={lens()}>
          <div class="column-head">
            <LensSwitch lens={lens()} onChoose={choose} />
          </div>
          <Conversation store={store} />
          <Waterfall store={store} />
          <Composer store={store} />
        </div>
        <aside
          id="context"
          aria-label="Context"
          ref={(element) => {
            context = element
          }}
        >
          <ContextPane store={store} />
        </aside>
      </div>
    </>
  )
}
