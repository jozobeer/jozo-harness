/**
 * The wire between the page's terminal pane and the shell the server runs for
 * it. The socket carries one JSON frame per message: output and the exit from
 * the shell, a line of input from the page. There is no PTY behind it yet, so a
 * line is the unit the page can send and the shell's own echo is its answer.
 */

/** Where the terminal socket lives, beside the page's RPC socket. */
export const TERMINAL_PATH = '/terminal'

/** One frame from the shell: what it printed, or how it ended. */
export type TerminalFrame =
  | { readonly type: 'output'; readonly stream: 'stdout' | 'stderr'; readonly data: string }
  | { readonly type: 'exit'; readonly code: number }

/** One frame the page sends: a line for the shell, or a request to stop it. */
export type TerminalInput =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'close' }

/** True when a value names one of the two streams a shell writes. */
const isStream = (value: unknown): value is 'stdout' | 'stderr' =>
  value === 'stdout' || value === 'stderr'

/** The frame a text carries, or undefined for one this side does not know. */
export const terminalFrameOf = (text: string): TerminalFrame | undefined => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const frame = value as Record<string, unknown>
  if (
    frame['type'] === 'output' &&
    typeof frame['data'] === 'string' &&
    isStream(frame['stream'])
  ) {
    return { type: 'output', stream: frame['stream'], data: frame['data'] }
  }
  return frame['type'] === 'exit' && typeof frame['code'] === 'number'
    ? { type: 'exit', code: frame['code'] }
    : undefined
}

/** The input a text carries, or undefined for one this side does not know. */
export const terminalInputOf = (text: string): TerminalInput | undefined => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const frame = value as Record<string, unknown>
  if (frame['type'] === 'close') return { type: 'close' }
  return frame['type'] === 'input' && typeof frame['data'] === 'string'
    ? { type: 'input', data: frame['data'] }
    : undefined
}

/** The session a terminal URL names; undefined when it names none. */
export const terminalSessionOf = (url: string): string | undefined => {
  const session = new URL(url, 'http://127.0.0.1').searchParams.get('session')
  return session === null || session === '' ? undefined : session
}

/** The terminal socket one session listens on, at the host the page's RPC socket names. */
export const terminalSocketAt = (uiUrl: string, sessionId: string): string => {
  const url = new URL(uiUrl)
  url.pathname = TERMINAL_PATH
  url.searchParams.set('session', sessionId)
  return url.toString()
}
