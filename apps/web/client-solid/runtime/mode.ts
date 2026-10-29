/** Which runtime the page should show. */
export type RuntimeMode = 'server' | 'browser'

/**
 * The Node-backed page stays the default. `?runtime=browser` is the explicit
 * opt-in, so the existing server, its logs, and its workspace are unchanged.
 */
export const runtimeModeFrom = (search: string): RuntimeMode =>
  new URLSearchParams(search).get('runtime') === 'browser' ? 'browser' : 'server'
