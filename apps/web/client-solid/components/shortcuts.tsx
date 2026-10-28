import {
  For,
  Show,
  createContext,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
} from 'solid-js'
import { Portal } from 'solid-js/web'
import { useTranslate } from '../i18n.ts'
import {
  SHORTCUTS,
  SHORTCUTS_KEY,
  boundChord,
  chordLabel,
  chordOf,
  isChord,
  matches,
  rebind,
  saveBindings,
  shortcutsFrom,
  type Bindings,
  type Chord,
  type Rebinding,
  type ShortcutId,
} from '../shortcuts.ts'
import { Button } from './ui/button.tsx'

/** The keys the page answers to now, and the one place a rebind is kept. */
export interface Shortcuts {
  readonly bindings: Accessor<Bindings>
  readonly bind: (id: ShortcutId, chord: Chord) => Rebinding
  readonly reset: () => void
}

const keptBindings = (): Bindings => {
  try {
    return shortcutsFrom(localStorage.getItem(SHORTCUTS_KEY))
  } catch {
    // A private window may refuse storage; the page keeps its default keys.
    return {}
  }
}

/** The keys this page answers to, read where the reader last left them. */
export const createShortcuts = (): Shortcuts => {
  const [bindings, setBindings] = createSignal<Bindings>(keptBindings())
  const keep = (next: Bindings): void => {
    setBindings(next)
    saveBindings(localStorage, next)
  }
  return {
    bindings,
    bind: (id, chord) => {
      const result = rebind(bindings(), id, chord)
      if (result.ok) keep(result.bindings)
      return result
    },
    reset: () => keep({}),
  }
}

/** Outside a page that keeps keys, every action answers to what it ships with. */
export const ShortcutsContext = createContext<Shortcuts>({
  bindings: () => ({}),
  bind: (id, chord) => ({ ok: true, bindings: { [id]: chord } }),
  reset: () => undefined,
})

export const useShortcuts = (): Shortcuts => useContext(ShortcutsContext)

/**
 * The list of keys. Change takes the next press as the new key and refuses a
 * key another action already answers to, before anything is kept.
 */
export const ShortcutsDialog = (props: { onClose: () => void }) => {
  const t = useTranslate()
  const shortcuts = useShortcuts()
  const [listening, setListening] = createSignal<ShortcutId | undefined>()
  const [problem, setProblem] = createSignal('')
  let dialog: HTMLDivElement | undefined

  const start = (id: ShortcutId): void => {
    setProblem('')
    setListening(id)
  }

  /** Escape and the list's own key give the page back. */
  const closes = (event: KeyboardEvent): boolean =>
    event.key === 'Escape' || matches(shortcuts.bindings(), 'shortcuts.open', event)

  /** The first press after Change becomes the key, unless another action owns it. */
  const accept = (id: ShortcutId, event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setListening(undefined)
      setProblem('')
      return
    }
    const chord = chordOf(event)
    if (chord === undefined || !isChord(chord)) return
    const result = shortcuts.bind(id, chord)
    if (!result.ok) {
      setProblem(t('shortcuts.conflict') + ' ' + t(result.conflict.label))
      return
    }
    setListening(undefined)
    setProblem('')
  }

  /**
   * The listener sits in the capture phase because the page's own handlers
   * answer on the document, and a modal must not let the key through to them.
   */
  const capture = (event: KeyboardEvent): void => {
    const id = listening()
    event.stopImmediatePropagation()
    if (id === undefined) {
      if (closes(event)) props.onClose()
      return
    }
    event.preventDefault()
    accept(id, event)
  }

  const keyOf = (id: ShortcutId): string | undefined =>
    listening() === id ? t('shortcuts.listening') : undefined

  onMount(() => {
    document.addEventListener('keydown', capture, true)
    onCleanup(() => document.removeEventListener('keydown', capture, true))
    dialog?.focus()
  })
  return (
    <Portal>
      <div
        class="shortcuts-backdrop"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) props.onClose()
        }}
      >
        <div
          class="shortcuts-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcuts-title"
          tabindex="-1"
          ref={(node) => {
            dialog = node
          }}
        >
          <h2 class="shortcuts-title" id="shortcuts-title">
            {t('shortcuts.title')}
          </h2>
          <ul class="shortcuts-list">
            <For each={SHORTCUTS}>
              {(shortcut) => {
                const key = (): string =>
                  keyOf(shortcut.id) ?? chordLabel(boundChord(shortcuts.bindings(), shortcut))
                const changed = (): boolean =>
                  boundChord(shortcuts.bindings(), shortcut) !== shortcut.chord
                return (
                  <li class="shortcut-row">
                    <span class="shortcut-what">{t(shortcut.label)}</span>
                    <kbd
                      class="shortcut-key"
                      title={
                        changed()
                          ? t('shortcuts.default') + ' ' + chordLabel(shortcut.chord)
                          : undefined
                      }
                    >
                      {key()}
                    </kbd>
                    <Button
                      class="shortcut-change"
                      variant="quiet"
                      type="button"
                      aria-label={t('shortcuts.change') + ' ' + t(shortcut.label)}
                      onClick={() => start(shortcut.id)}
                    >
                      {t('shortcuts.change')}
                    </Button>
                  </li>
                )
              }}
            </For>
          </ul>
          <Show when={problem() !== ''}>
            <p class="shortcuts-problem" role="alert">
              {problem()}
            </p>
          </Show>
          <p class="shortcuts-note">{t('shortcuts.note')}</p>
          <div class="shortcuts-actions">
            <Button
              class="shortcut-reset"
              variant="quiet"
              type="button"
              onClick={() => {
                shortcuts.reset()
                setListening(undefined)
                setProblem('')
              }}
            >
              {t('shortcuts.reset')}
            </Button>
            <Button
              class="shortcut-close"
              variant="quiet"
              type="button"
              onClick={() => props.onClose()}
            >
              {t('shortcuts.close')}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  )
}
