/** Where each workspace's hand-picked row order is kept between visits. */
export const SESSION_ORDER_KEY = 'jzh.session-order'

/** One workspace's order, keyed by the folder the rows live in. */
export type KeptOrder = Readonly<Record<string, ReadonlyArray<string>>>

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The ids one workspace's entry names; anything else reads as no order at all. */
const idsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

const keptOrderOf = (value: unknown): KeptOrder => {
  if (!isRecord(value)) return {}
  const order: Record<string, ReadonlyArray<string>> = {}
  for (const [cwd, ids] of Object.entries(value)) {
    const kept = idsOf(ids)
    // A workspace with no named row is not ordered, so recency keeps it.
    if (kept.length > 0) order[cwd] = kept
  }
  return order
}

/**
 * The orders an earlier visit left under the key. A workspace whose entry is
 * unreadable is left out, so it falls back to recency instead of an empty rail.
 */
export const orderFrom = (stored: string | null): KeptOrder => {
  if (stored === null) return {}
  try {
    return keptOrderOf(JSON.parse(stored))
  } catch {
    return {}
  }
}

/** Keeps every workspace's order for the next visit. */
export const keepOrder = (order: KeptOrder): void => {
  localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(order))
}

/**
 * Moves one row by one place, and returns the list unchanged when the row is
 * already at the end it was asked to leave. The list is not changed in place.
 */
export const movedIn = <T extends string>(
  ids: ReadonlyArray<T>,
  id: T,
  delta: number,
): ReadonlyArray<T> => {
  const at = ids.indexOf(id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= ids.length) return ids
  const moved = ids[at]
  if (moved === undefined) return ids
  const next = [...ids]
  next.splice(at, 1)
  next.splice(to, 0, moved)
  return next
}

/** A workspace's order, with one row moved; a folder nobody ordered keeps none. */
export const withMoved = (
  order: KeptOrder,
  cwd: string,
  ids: ReadonlyArray<string>,
  id: string,
  delta: number,
): KeptOrder => {
  const current = hasOwn(order, cwd) ? (order[cwd] ?? []) : ids
  const next = movedIn(current, id, delta)
  if (next === current) return order
  return { ...order, [cwd]: next }
}
