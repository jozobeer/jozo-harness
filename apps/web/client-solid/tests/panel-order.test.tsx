import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PANELS,
  PANEL_KINDS,
  PANEL_ORDER_KEY,
  canPanelMove,
  keepPanels,
  panelsFrom,
  withPanelHidden,
  withPanelMoved,
} from '../panel-order.ts'

describe('the right pane tab order', () => {
  test('a reader who never reordered sees the tabs in the order they arrived in', () => {
    expect(panelsFrom(null)).toEqual(DEFAULT_PANELS)
    expect(panelsFrom(null).order).toEqual([...PANEL_KINDS])
  })

  test('moves one tab by one place and stops at either end', () => {
    const moved = withPanelMoved(DEFAULT_PANELS, 'browser', -1)
    expect(moved.order.slice(0, 3)).toEqual(['changes', 'browser', 'files'])
    const atStart = withPanelMoved(DEFAULT_PANELS, 'changes', -1)
    expect(atStart).toBe(DEFAULT_PANELS)
    expect(canPanelMove(DEFAULT_PANELS, 'changes', -1)).toBe(false)
    expect(canPanelMove(DEFAULT_PANELS, 'changes', 1)).toBe(true)
    expect(withPanelMoved(DEFAULT_PANELS, 'log', 1)).toBe(DEFAULT_PANELS)
  })

  test('keeps the chosen order for the next visit under its own key', () => {
    const panels = withPanelMoved(DEFAULT_PANELS, 'changes', 2)
    keepPanels(panels)
    expect(panelsFrom(localStorage.getItem(PANEL_ORDER_KEY))).toEqual(panels)
    expect(panels.order.slice(0, 3)).toEqual(['files', 'browser', 'changes'])
  })

  test('reads an order saved before tabs could be put away as a plain list', () => {
    expect(panelsFrom(JSON.stringify(['run', 'changes']))).toEqual({
      order: ['run', 'changes', 'files', 'browser', 'settings', 'trajectory', 'log'],
      hidden: [],
    })
  })

  test('lets a tab added after the reader chose join at the end instead of vanishing', () => {
    expect(
      panelsFrom(JSON.stringify({ order: ['trajectory', 'changes'], hidden: [] })).order,
    ).toEqual(['trajectory', 'changes', 'files', 'browser', 'run', 'settings', 'log'])
  })

  test('an unreadable list or a repeated name falls back to a sane strip', () => {
    expect(panelsFrom('not json')).toEqual(DEFAULT_PANELS)
    expect(panelsFrom('42')).toEqual(DEFAULT_PANELS)
    expect(panelsFrom(JSON.stringify({ order: ['run', 'run', 'gone'], hidden: [] }))).toEqual({
      order: ['run', 'changes', 'files', 'browser', 'settings', 'trajectory', 'log'],
      hidden: [],
    })
  })

  test('a tab put away leaves the strip and comes back at the end when asked for', () => {
    const hidden = withPanelHidden(DEFAULT_PANELS, 'files', true)
    expect(hidden.order).toEqual(['changes', 'browser', 'run', 'settings', 'trajectory', 'log'])
    expect(hidden.hidden).toEqual(['files'])
    const restored = withPanelHidden(hidden, 'files', false)
    expect(restored.order).toEqual([
      'changes',
      'browser',
      'run',
      'settings',
      'trajectory',
      'log',
      'files',
    ])
    expect(restored.hidden).toEqual([])
    // Asking for what already holds changes nothing, so the page need not save.
    expect(withPanelHidden(hidden, 'files', true)).toBe(hidden)
    expect(withPanelHidden(DEFAULT_PANELS, 'files', false)).toBe(DEFAULT_PANELS)
  })

  test('the last visible tab and the settings tab cannot be put away', () => {
    const one = { order: ['run'] as const, hidden: PANEL_KINDS.filter((tab) => tab !== 'run') }
    expect(withPanelHidden(one, 'run', true)).toBe(one)
    // Settings holds the list that brings the others back, so it stays reachable.
    expect(withPanelHidden(DEFAULT_PANELS, 'settings', true)).toBe(DEFAULT_PANELS)
    expect(panelsFrom(JSON.stringify({ order: [], hidden: [...PANEL_KINDS] }))).toEqual(
      DEFAULT_PANELS,
    )
  })

  test('restoring a tab after a reload leaves it visible in the chosen order', () => {
    const hidden = withPanelHidden(withPanelMoved(DEFAULT_PANELS, 'run', -1), 'browser', true)
    keepPanels(hidden)
    const reread = panelsFrom(localStorage.getItem(PANEL_ORDER_KEY))
    expect(reread.order).toEqual(['changes', 'files', 'run', 'settings', 'trajectory', 'log'])
    const restored = withPanelHidden(reread, 'browser', false)
    expect(restored.order).toEqual([
      'changes',
      'files',
      'run',
      'settings',
      'trajectory',
      'log',
      'browser',
    ])
  })
})
