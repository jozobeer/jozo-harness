import { THEME_KEY, themeAttribute, themeFrom, type Theme } from '../src/ui/theme.ts'

/**
 * The browser the page runs in, named once. These declarations are the surface
 * the page uses, written here rather than read from the DOM library, so the
 * store that drives the page can be read and run where no browser is in scope.
 */
declare const window: {
  readonly location: {
    readonly protocol: string
    readonly host: string
    readonly pathname: string
    readonly search: string
  }
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

/** Where the socket lives, given the protocol and host the page was served with. */
export const socketAt = (protocol: string, host: string, token?: string): string =>
  (protocol === 'https:' ? 'wss://' : 'ws://') +
  host +
  '/ui' +
  (token === undefined ? '' : '?token=' + encodeURIComponent(token))

/** The token the page was opened with; the ready URL carries it in the query. */
export const tokenOfSearch = (search: string): string | undefined => {
  const token = new URLSearchParams(search).get('token')
  return token === null || token === '' ? undefined : token
}

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

/** The socket this page talks to: the host that served it, and its token. */
export const pageSocket = (): string =>
  socketAt(window.location.protocol, window.location.host, tokenOfSearch(window.location.search))

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

/**
 * Says in the address bar which session the page reads, so a reload returns to
 * it. The blank page names none, and keeps whatever else the address carries.
 */
export const addressSession = (id: string | undefined): void => {
  const params = new URLSearchParams(window.location.search)
  if (id === undefined) params.delete('session')
  else params.set('session', id)
  const query = params.toString()
  history.replaceState(null, '', query === '' ? window.location.pathname : '?' + query)
}
