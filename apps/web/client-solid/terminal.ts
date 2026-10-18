/**
 * The page's side of the terminal socket. The pane sends one JSON frame per
 * message and reads one back; the browser's WebSocket carries them, and a test
 * hands in the same shape so the store can run outside a browser.
 */

/** The part of a WebSocket the terminal pane uses. */
export interface TerminalSocket {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(): void
}

/** Opens one terminal socket; a page uses the browser's own. */
export type TerminalSocketFactory = (url: string) => TerminalSocket

/** The text one socket frame carries, whichever binary shape the socket hands over. */
export const frameTextOf = (data: unknown): string => {
  if (typeof data === 'string') return data
  return data instanceof Uint8Array ? new TextDecoder().decode(data) : ''
}

/** The browser's own socket, which a page has wherever it paints. */
export const browserTerminalSocket: TerminalSocketFactory = (url) =>
  new WebSocket(url) as unknown as TerminalSocket
