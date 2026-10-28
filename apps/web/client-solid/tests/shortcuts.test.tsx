import { describe, expect, test } from 'vitest'
import {
  SHORTCUTS,
  boundChord,
  chordLabel,
  chordLabelFor,
  chordOf,
  holderOf,
  matches,
  rebind,
  saveBindings,
  shortcutOf,
  shortcutsFrom,
  type ShortcutId,
} from '../shortcuts.ts'

const rowOf = (id: ShortcutId) => {
  const row = shortcutOf(id)
  if (row === undefined) throw new Error('the table does not know ' + id)
  return row
}

const press = (key: string, mod = false, alt = false) => ({
  key,
  metaKey: mod,
  ctrlKey: false,
  altKey: alt,
})

describe('the keys the page answers to', () => {
  test('keeps the key each action ships with until the reader changes one', () => {
    expect(boundChord({}, rowOf('rail.toggle'))).toBe('Mod+B')
    expect(boundChord({}, rowOf('board.search'))).toBe('Mod+K')
    expect(boundChord({}, rowOf('approval.approve'))).toBe('y')
    expect(shortcutsFrom(null)).toEqual({})
    expect(SHORTCUTS.length).toBeGreaterThan(0)
  })

  test('answers to a rebound key after a reload, and no longer to the old one', () => {
    const bindings = shortcutsFrom('{"rail.toggle":"Mod+J"}')
    expect(matches(bindings, 'rail.toggle', press('j', true))).toBe(true)
    expect(matches(bindings, 'rail.toggle', press('b', true))).toBe(false)
    expect(matches(bindings, 'board.search', press('k', true))).toBe(true)
  })

  test('drops a stored line this build cannot answer to', () => {
    expect(shortcutsFrom('not json')).toEqual({})
    expect(shortcutsFrom('[]')).toEqual({})
    expect(shortcutsFrom('{"no.such.action":"Mod+J"}')).toEqual({})
    expect(shortcutsFrom('{"rail.toggle":"Mod+Shift"}')).toEqual({})
    expect(shortcutsFrom('{"rail.toggle":7}')).toEqual({})
  })

  test('reads a press as Mod plus the letter, and leaves Alt alone', () => {
    expect(chordOf(press('B', true))).toBe('Mod+b')
    expect(chordOf({ ...press('b'), ctrlKey: true })).toBe('Mod+b')
    expect(chordOf(press('/'))).toBe('/')
    expect(chordOf(press('b', false, true))).toBeUndefined()
    expect(chordOf(press('ArrowDown', true))).toBe('Mod+ArrowDown')
  })

  test('refuses a key another action already answers to, naming that action', () => {
    const refused = rebind({}, 'rail.toggle', 'Mod+K')
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.conflict.id).toBe('board.search')
    const taken = rebind({}, 'rail.toggle', 'Mod+J')
    expect(taken).toEqual({ ok: true, bindings: { 'rail.toggle': 'Mod+J' } })
  })

  test('frees the default of an action once that action moves away', () => {
    const moved = shortcutsFrom('{"board.search":"Mod+J"}')
    expect(holderOf(moved, 'Mod+K', 'rail.toggle')).toBeUndefined()
    expect(rebind(moved, 'rail.toggle', 'Mod+K').ok).toBe(true)
  })

  test('matches one action at a time, bare or with Mod', () => {
    expect(matches({}, 'board.searchBare', press('/'))).toBe(true)
    expect(matches({}, 'board.searchBare', press('/', true))).toBe(false)
    expect(matches({}, 'approval.approve', press('Y'))).toBe(true)
    expect(matches({}, 'approval.reject', press('y'))).toBe(false)
  })

  test('draws a chord the way each platform names it', () => {
    expect(chordLabelFor('Mod+B', true)).toBe('⌘B')
    expect(chordLabelFor('Mod+B', false)).toBe('Ctrl+B')
    expect(chordLabelFor('y', false)).toBe('Y')
    expect(chordLabelFor('/', false)).toBe('/')
    // The page draws with the platform it runs on, which a test browser names.
    expect(chordLabel('Mod+K')).toMatch(/^(⌘K|Ctrl\+K)$/)
  })

  test('keeps the rebinds in storage, and survives a browser that refuses it', () => {
    const kept: Record<string, string> = {}
    saveBindings(
      {
        setItem: (key: string, value: string) => {
          kept[key] = value
        },
      },
      { 'rail.toggle': 'Mod+J' },
    )
    expect(kept['jzh.shortcuts']).toBe('{"rail.toggle":"Mod+J"}')
    expect(() =>
      saveBindings(
        {
          setItem: () => {
            throw new Error('private window')
          },
        },
        {},
      ),
    ).not.toThrow()
  })
})
