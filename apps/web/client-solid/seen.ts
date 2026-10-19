import { createContext, createEffect, createSignal, on, useContext, type Accessor } from 'solid-js'

/** Where the reader's last look at each session is kept between visits. */
export const SEEN_KEY = 'jzh.seen'

/**
 * When the reader last had each session open, and when this browser began to
 * keep count: a session it never opened counts as seen at that first visit, so
 * the first page load does not light every old finish.
 */
interface Looks {
  readonly since: number
  readonly at: Readonly<Record<string, number>>
}

const isLooks = (value: unknown): value is Looks =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Looks).since === 'number' &&
  typeof (value as Looks).at === 'object' &&
  (value as Looks).at !== null

/** The looks an earlier visit kept; anything unreadable starts the count now. */
export const looksFrom = (stored: string | null, now: number): Looks => {
  try {
    const parsed: unknown = JSON.parse(stored ?? 'null')
    return isLooks(parsed) ? parsed : { since: now, at: {} }
  } catch {
    return { since: now, at: {} }
  }
}

const readLooks = (now: number): Looks => {
  try {
    return looksFrom(localStorage.getItem(SEEN_KEY), now)
  } catch {
    // A private window may refuse storage; the looks last this visit only.
    return { since: now, at: {} }
  }
}

const keepLooks = (looks: Looks): void => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(looks))
  } catch {
    // Keeping the looks is a convenience; a browser that refuses it is not a failure.
  }
}

/** Whether a finish is news to the reader: it came after they last had its session open. */
export interface Seen {
  readonly fresh: (sessionId: string, endedAt: number) => boolean
}

/**
 * Notes a look at a session when it is opened and again when it is left, so a
 * finish stays green until the reader has had it on screen and moved on.
 */
export const createSeen = (open: Accessor<string>, now: () => number = Date.now): Seen => {
  const [looks, setLooks] = createSignal(readLooks(now()))
  // Kept at once, so the first visit's count survives a reload that opens nothing.
  keepLooks(looks())
  const look = (sessionId: string): void => {
    if (sessionId === '') return
    const next = { ...looks(), at: { ...looks().at, [sessionId]: now() } }
    setLooks(next)
    keepLooks(next)
  }
  createEffect(
    on(open, (sessionId, before) => {
      if (before !== undefined) look(before)
      look(sessionId)
    }),
  )
  return {
    fresh: (sessionId, endedAt) => endedAt > (looks().at[sessionId] ?? looks().since),
  }
}

/** Outside a page that keeps looks, every finish reads as seen. */
export const SeenContext = createContext<Seen>({ fresh: () => false })

export const useSeen = (): Seen => useContext(SeenContext)
