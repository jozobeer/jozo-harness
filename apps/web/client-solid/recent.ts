/** Where the reader's folded and opened Recent folders are kept between visits. */
export const RECENT_FOLDED_KEY = 'jzh.recent-folded'
export const RECENT_SHOWN_KEY = 'jzh.recent-shown'

/** The folder paths an earlier visit left under one key; anything unreadable reads as none. */
export const pathsFrom = (stored: string | null): ReadonlySet<string> => {
  if (stored === null) return new Set()
  try {
    const parsed: unknown = JSON.parse(stored)
    return new Set(
      Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

/** Keeps one set of folder paths for the next visit. */
export const keepPaths = (key: string, paths: ReadonlySet<string>): void => {
  localStorage.setItem(key, JSON.stringify([...paths]))
}
