import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginRowView } from '../shared/rpc.ts'
import { originAllowed, requestAuthorized, type CodeExchange, type PublicOrigin } from './auth.ts'
import type { TailnetAddresses } from './tailnet.ts'
/** The gate the plugin list shares with the artifact route: same host, origin, and token. */
export interface PluginsGate {
  /** The rows the run in front of the page was built from, in composition order. */
  readonly rows: () => ReadonlyArray<PluginRowView>
  readonly port: number
  readonly publicOrigin: PublicOrigin | undefined
  readonly tailnet: TailnetAddresses | undefined
  readonly token: string
  readonly codes: CodeExchange
}

const refuse = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

/**
 * Answers the plugin rows the page lists. A list is read-only, so it shares the
 * artifact route's gate: a foreign origin and a request without the cookie, a
 * code, or the token are refused before any row is read.
 */
export const answerPlugins = (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  gate: PluginsGate,
): boolean => {
  if (path !== '/plugins') return false
  if (request.method !== 'GET') {
    refuse(response, 405, 'method not allowed')
    return true
  }
  if (!originAllowed(request.headers.origin, gate.port, gate.publicOrigin, gate.tailnet)) {
    refuse(response, 403, 'forbidden')
    return true
  }
  if (!requestAuthorized(request.url ?? '', request.headers.cookie, gate)) {
    refuse(response, 401, 'a token or a code is required')
    return true
  }
  // A change lands on the next start or in this run, so the page must not keep
  // an older list: the rows are read on every request.
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify({ rows: gate.rows() }))
  return true
}
