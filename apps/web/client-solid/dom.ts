import { THEME_KEY, themeAttribute, themeFrom, type Theme } from '../src/ui/theme.ts'

/**
 * The browser the page runs in, named once. These declarations are the surface
 * the page uses, written here rather than read from the DOM library, so the
 * store that drives the page can be read and run where no browser is in scope.
 */
declare const window: {
  readonly location: { readonly protocol: string; readonly host: string; readonly search: string }
}
declare const document: {
  readonly documentElement: { readonly dataset: Record<string, string | undefined> }
}
declare const history: {
  replaceState: (data: unknown, unused: string, url?: string) => void
}
declare const localStorage: {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}
/** The frame clock, which a page has only where it is painted. */
declare const requestAnimationFrame: ((run: (time: number) => void) => number) | undefined

/** Where the socket lives, given the protocol the page was served with. */
export const socketAt = (protocol: string, host: string): string =>
  (protocol === 'https:' ? 'wss://' : 'ws://') + host + '/ui'

/**
 * Runs `run` before the page is painted next, or on the next turn of the event
 * loop where there is no paint to wait for. A page handed a whole log at once
 * folds everything it has received once per frame through this, so reading a long
 * session costs one drawing rather than one per event.
 */
export const onNextFrame = (run: () => void): void => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => run())
    return
  }
  setTimeout(run, 0)
}

/** The socket this page talks to: the host that served it. */
export const pageSocket = (): string => socketAt(window.location.protocol, window.location.host)

/** The search string the page was opened with, which may name a session. */
export const pageSearch = (): string => window.location.search

/** Writes the reader's choice where the stylesheet reads it; the system's is its own. */
export const showTheme = (theme: Theme): void => {
  const attribute = themeAttribute(theme)
  if (attribute === undefined) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = attribute
}

/** The theme the reader chose on an earlier visit, or the system's. */
export const keptTheme = (): Theme => themeFrom(localStorage.getItem(THEME_KEY))

/** Keeps the reader's choice for the next visit. */
export const keepTheme = (theme: Theme): void => {
  localStorage.setItem(THEME_KEY, theme)
}

/** Says in the address bar which session the page reads, so a reload returns to it. */
export const addressSession = (id: string): void => {
  history.replaceState(null, '', '?session=' + encodeURIComponent(id))
}
