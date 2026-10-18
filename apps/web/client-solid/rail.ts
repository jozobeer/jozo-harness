/** How wide the rail may be drawn, and where a page that has no memory of it starts. */
export const RAIL_MIN = 264
export const RAIL_MAX = 420
export const RAIL_DEFAULT = 280

/** Where the reader's width and fold are kept between visits. */
export const RAIL_KEY = 'jzh.rail-w'
export const RAIL_COLLAPSED_KEY = 'jzh.rail-collapsed'

/** A width inside the range the rail allows. */
export const clampRailWidth = (width: number): number =>
  Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(width)))

/** What to make of a stored width: anything unusable reads the default, and the rest is clamped. */
export const railWidthFrom = (stored: string | null): number => {
  if (stored === null || stored.trim() === '') return RAIL_DEFAULT
  const width = Number(stored)
  return Number.isFinite(width) ? clampRailWidth(width) : RAIL_DEFAULT
}

/** The rail is folded only when an earlier visit left it so. */
export const railCollapsedFrom = (stored: string | null): boolean => stored === 'true'
