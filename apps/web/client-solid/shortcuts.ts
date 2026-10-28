import type { MessageKey } from './locale.ts'

/** Where the browser keeps the keys the reader has bound. */
export const SHORTCUTS_KEY = 'jzh.shortcuts'

/** The platform's command key: `Mod+B` means Cmd+B on a Mac and Ctrl+B elsewhere. */
const MOD = 'Mod+'

/** One key press, alone or with Mod. Letters are written in lower case. */
export type Chord = string

/** One action the page answers to, with the key it ships with. */
type Row = {
  readonly id: string
  readonly chord: Chord
  readonly label: MessageKey
}

/**
 * Every shortcut in one table. The list the reader sees and the handlers that
 * match a press both read it, so a key is never described in two places.
 */
export const SHORTCUTS = [
  { id: 'shortcuts.open', chord: 'Mod+/', label: 'shortcuts.list' },
  { id: 'rail.toggle', chord: 'Mod+B', label: 'shortcuts.rail' },
  { id: 'board.search', chord: 'Mod+K', label: 'shortcuts.search' },
  { id: 'board.searchBare', chord: '/', label: 'shortcuts.searchBare' },
  { id: 'approval.approve', chord: 'y', label: 'shortcuts.approve' },
  { id: 'approval.reject', chord: 'n', label: 'shortcuts.reject' },
] as const satisfies ReadonlyArray<Row>

export type Shortcut = (typeof SHORTCUTS)[number]
export type ShortcutId = Shortcut['id']

/** The keys the reader has changed; an absent id keeps the key it ships with. */
export type Bindings = Partial<Record<ShortcutId, Chord>>

/** The key a shortcut answers to now: the reader's choice when there is one. */
export const boundChord = (bindings: Bindings, shortcut: Shortcut): Chord =>
  bindings[shortcut.id] ?? shortcut.chord

/** A chord the page can answer to: one key, alone or with Mod. */
const ONE_KEY = /^(?:Mod\+)?[^+\s]$/

export const isChord = (value: string): boolean => ONE_KEY.test(value)

export const isShortcutId = (value: string): value is ShortcutId =>
  SHORTCUTS.some((shortcut) => shortcut.id === value)

/** The one spelling of a chord: a letter is lower case, as a press reads it. */
const normalized = (chord: Chord): Chord => {
  const withMod = chord.startsWith(MOD)
  const key = (withMod ? chord.slice(MOD.length) : chord).toLowerCase()
  return withMod ? MOD + key : key
}

/** The object a stored line holds, or none when the line is not one. */
const storedRecord = (raw: string | null): object | undefined => {
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A stored line the page can answer to, with the one spelling of its chord. */
const keptEntry = (id: string, chord: unknown): readonly [ShortcutId, Chord] | undefined => {
  if (!isShortcutId(id) || typeof chord !== 'string' || !isChord(chord)) return undefined
  return [id, normalized(chord)]
}

/**
 * The reader's kept rebinds. A stored line this build cannot answer to is
 * dropped rather than kept, so a stale page never leaves a key dead.
 */
export const shortcutsFrom = (raw: string | null): Bindings => {
  const stored = storedRecord(raw)
  if (stored === undefined) return {}
  const kept: Record<string, Chord> = {}
  for (const [id, chord] of Object.entries(stored)) {
    const entry = keptEntry(id, chord)
    if (entry !== undefined) kept[entry[0]] = entry[1]
  }
  return kept
}

/** The shortcut a key already belongs to, or none while the key is free. */
export const holderOf = (
  bindings: Bindings,
  chord: Chord,
  except: ShortcutId,
): Shortcut | undefined =>
  SHORTCUTS.find(
    (shortcut) =>
      shortcut.id !== except && normalized(boundChord(bindings, shortcut)) === normalized(chord),
  )

export type Rebinding =
  | { readonly ok: true; readonly bindings: Bindings }
  | { readonly ok: false; readonly conflict: Shortcut }

/** Binds a key, refusing one that another action already answers to. */
export const rebind = (bindings: Bindings, id: ShortcutId, chord: Chord): Rebinding => {
  const conflict = holderOf(bindings, chord, id)
  if (conflict !== undefined) return { ok: false, conflict }
  return { ok: true, bindings: { ...bindings, [id]: chord } }
}

/** What a key press carries, or none while the press is not a chord the page knows. */
export type Pressed = {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
}

/**
 * The chord a press carries. Alt is left out on purpose: it types a symbol on a
 * Mac, and no action of the page asks for one.
 */
export const chordOf = (event: Pressed): Chord | undefined => {
  if (event.altKey) return undefined
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  return event.metaKey || event.ctrlKey ? MOD + key : key
}

/** Whether the press is the key an action answers to. */
export const matches = (bindings: Bindings, id: ShortcutId, event: Pressed): boolean =>
  SHORTCUTS.some(
    (shortcut) =>
      shortcut.id === id && chordOf(event) === normalized(boundChord(bindings, shortcut)),
  )

/** The row an action answers to, or none when this build does not know it. */
export const shortcutOf = (id: ShortcutId): Shortcut | undefined =>
  SHORTCUTS.find((shortcut) => shortcut.id === id)

/** A chord drawn the way a platform names its keys. */
export const chordLabelFor = (chord: Chord, mac: boolean): string => {
  const withMod = chord.startsWith(MOD)
  const key = withMod ? chord.slice(MOD.length) : chord
  const named = key.length === 1 ? key.toUpperCase() : key
  return (withMod ? (mac ? '⌘' : 'Ctrl+') : '') + named
}

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** A chord drawn the way this browser names its keys. */
export const chordLabel = (chord: Chord): string => chordLabelFor(chord, isMac())

/** Keeps the rebinds; a browser that refuses storage still answers this visit. */
export const saveBindings = (storage: Pick<Storage, 'setItem'>, bindings: Bindings): void => {
  try {
    storage.setItem(SHORTCUTS_KEY, JSON.stringify(bindings))
  } catch {
    // Keeping the keys is a convenience; a private window that refuses is not a failure.
  }
}
