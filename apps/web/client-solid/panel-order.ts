import { movedIn } from './order.ts'

/** Where the right pane's hand-picked tab order and put-away tabs are kept. */
export const PANEL_ORDER_KEY = 'jzh.panel-order'

/** The tabs the right pane draws, in the order they arrived in. */
export const PANEL_KINDS = ['changes', 'files', 'browser', 'run', 'settings', 'trajectory'] as const

export type PanelTab = (typeof PANEL_KINDS)[number]

/** The tabs the reader sees, and the ones they put away until asked for. */
export interface KeptPanels {
  readonly order: ReadonlyArray<PanelTab>
  readonly hidden: ReadonlyArray<PanelTab>
}

/** What a reader who never reordered sees. */
export const DEFAULT_PANELS: KeptPanels = { order: PANEL_KINDS, hidden: [] }

const isTab = (value: unknown): value is PanelTab =>
  typeof value === 'string' && (PANEL_KINDS as ReadonlyArray<string>).includes(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const tabsOf = (value: unknown): ReadonlyArray<PanelTab> =>
  Array.isArray(value) ? value.filter(isTab) : []

const unique = (tabs: ReadonlyArray<PanelTab>): ReadonlyArray<PanelTab> =>
  tabs.filter((tab, at) => tabs.indexOf(tab) === at)

/**
 * Drops unknown and repeated names, appends a tab added after the reader chose,
 * and refuses to leave the strip empty; the last visible tab stays.
 */
const settled = (order: ReadonlyArray<PanelTab>, hidden: ReadonlyArray<PanelTab>): KeptPanels => {
  const putAway = unique(hidden)
  const kept = unique(order).filter((tab) => !putAway.includes(tab))
  const shown = [
    ...kept,
    ...PANEL_KINDS.filter((tab) => !kept.includes(tab) && !putAway.includes(tab)),
  ]
  if (shown.length === 0) return DEFAULT_PANELS
  return { order: shown, hidden: putAway.filter((tab) => !shown.includes(tab)) }
}

/**
 * The order and hidden tabs an earlier visit left. An order saved before tabs
 * could be put away is a plain list; anything unreadable falls back to default.
 */
export const panelsFrom = (stored: string | null): KeptPanels => {
  if (stored === null) return DEFAULT_PANELS
  let value: unknown
  try {
    value = JSON.parse(stored)
  } catch {
    return DEFAULT_PANELS
  }
  if (Array.isArray(value)) return settled(tabsOf(value), [])
  if (!isRecord(value)) return DEFAULT_PANELS
  return settled(tabsOf(value['order']), tabsOf(value['hidden']))
}

/** Keeps the reader's order and put-away tabs for the next visit. */
export const keepPanels = (panels: KeptPanels): void => {
  localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(panels))
}

/**
 * Moves one visible tab by one place, and returns the panels unchanged when the
 * tab already sits at the end it was asked to leave.
 */
export const withPanelMoved = (panels: KeptPanels, tab: PanelTab, delta: number): KeptPanels => {
  const next = movedIn(panels.order, tab, delta)
  return next === panels.order ? panels : { ...panels, order: next }
}

/** Whether a move would land, so a control can say so before the press. */
export const canPanelMove = (panels: KeptPanels, tab: PanelTab, delta: number): boolean =>
  withPanelMoved(panels, tab, delta) !== panels

/**
 * Hides or restores one tab. The last visible tab cannot be put away, so the
 * strip never comes up empty; restoring puts the tab back at the end.
 */
export const withPanelHidden = (panels: KeptPanels, tab: PanelTab, hidden: boolean): KeptPanels => {
  if (!hidden) {
    if (!panels.hidden.includes(tab)) return panels
    return settled(
      [...panels.order, tab],
      panels.hidden.filter((one) => one !== tab),
    )
  }
  if (panels.hidden.includes(tab)) return panels
  if (!panels.order.includes(tab)) return panels
  if (panels.order.length <= 1) return panels
  return {
    order: panels.order.filter((one) => one !== tab),
    hidden: [...panels.hidden, tab],
  }
}
