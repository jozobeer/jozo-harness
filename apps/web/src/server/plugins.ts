import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginChangeRequest, PluginsView } from '../shared/rpc.ts'
import { refusedBy, type RequestGate } from './auth.ts'

/** What one change left behind; a refusal names the status and the reason the page shows. */
export type PluginChangeAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string }

/**
 * The composition the plugin pane reads and changes. The port writes the settings
 * the next start reads; it never rebuilds the running Layer, which is why a
 * change can be offered beside a run that keeps its tools until it restarts.
 */
export interface PluginsPort {
  readonly view: () => PluginsView
  /** Every plugin name this build carries, so a name it lacks is refused before anything is written. */
  readonly known: () => ReadonlyArray<string>
  /** Applies one change; the view answers with the rows and failures it left. */
  readonly change: (change: PluginChangeRequest) => Promise<PluginChangeAnswer>
}

/** The gate the plugin views share with the artifact route, and the port they change. */
export interface PluginsGate extends RequestGate {
  readonly plugins: PluginsPort
}

/** A JSON request body larger than this is refused before it is parsed. */
const BODY_LIMIT = 64 * 1024

type BodyRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'failed' }

const refuse = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

const answerView = (response: ServerResponse, view: PluginsView): void => {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(view))
}

/** Reads one request body, refusing a stream that fails or grows past the cap. */
const readBody = (request: IncomingMessage): Promise<BodyRead> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = []
    let bytes = 0
    let settled = false
    const settle = (body: BodyRead): void => {
      if (settled) return
      settled = true
      resolve(body)
    }
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > BODY_LIMIT) {
        settle({ kind: 'too-large' })
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => settle({ kind: 'text', text: Buffer.concat(chunks).toString('utf8') }))
    request.on('error', () => settle({ kind: 'failed' }))
  })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One non-empty string field of a request body, or undefined when it is not one. */
const stringField = (raw: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = raw[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

const enabledChange = (
  raw: Readonly<Record<string, unknown>>,
  id: string,
): PluginChangeRequest | undefined => {
  const enabled = raw['enabled']
  return typeof enabled === 'boolean' ? { action: 'set-enabled', id, enabled } : undefined
}

const installChange = (
  raw: Readonly<Record<string, unknown>>,
  id: string,
): PluginChangeRequest | undefined => {
  const name = stringField(raw, 'name')
  return name === undefined ? undefined : { action: 'install', id, name }
}

/** The one change a body names, or undefined when it is not one this route takes. */
const changeOf = (raw: unknown): PluginChangeRequest | undefined => {
  if (!isRecord(raw)) return undefined
  const id = stringField(raw, 'id')
  if (id === undefined) return undefined
  const action = raw['action']
  if (action === 'set-enabled') return enabledChange(raw, id)
  if (action === 'install') return installChange(raw, id)
  if (action === 'retry') return { action: 'retry', id }
  return undefined
}

/** Why this install may not be written, before the port or the page touches anything. */
const installRefusal = (
  change: Extract<PluginChangeRequest, { action: 'install' }>,
  plugins: PluginsPort,
): string | undefined => {
  if (!plugins.known().includes(change.name)) {
    return 'this build does not have ' + change.name
  }
  const entry = plugins
    .view()
    .catalog.find((item) => item.id === change.id && item.name === change.name)
  if (entry === undefined) return change.name + ' is not a bundle this page installs'
  if (entry.needsConfig) {
    return change.name + ' needs config in the settings file, so the page cannot install it'
  }
  return undefined
}

/** The browser page's origin and credential, checked before a row is read or written. */
const gated = (request: IncomingMessage, response: ServerResponse, gate: PluginsGate): boolean => {
  const refusal = refusedBy(request, gate)
  if (refusal === undefined) return true
  refuse(response, refusal.status, refusal.message)
  return false
}

/** Applies one JSON change; a body this route cannot take never reaches the port. */
const answerChange = async (
  request: IncomingMessage,
  response: ServerResponse,
  gate: PluginsGate,
): Promise<void> => {
  const body = await readBody(request)
  if (body.kind === 'too-large') {
    refuse(response, 413, 'the plugin change is too large')
    return
  }
  if (body.kind === 'failed') {
    refuse(response, 400, 'the plugin change could not be read')
    return
  }
  let raw: unknown
  try {
    raw = JSON.parse(body.text)
  } catch {
    refuse(response, 400, 'the plugin change is not JSON')
    return
  }
  const change = changeOf(raw)
  if (change === undefined) {
    refuse(response, 400, 'the plugin change is not one this route takes')
    return
  }
  const refusal = change.action === 'install' ? installRefusal(change, gate.plugins) : undefined
  if (refusal !== undefined) {
    refuse(response, 400, refusal)
    return
  }
  const answer = await gate.plugins.change(change).catch((): PluginChangeAnswer => ({
    ok: false,
    status: 500,
    message: 'the plugin change failed',
  }))
  if (!answer.ok) {
    refuse(response, answer.status, answer.message)
    return
  }
  answerView(response, gate.plugins.view())
}

/**
 * Answers the plugin route: GET lists the rows, the optional bundles, and the
 * failed wirings; POST applies one change. Both share the artifact route's gate,
 * so a foreign origin and a request without the cookie, a code, or the token are
 * refused before any row is read or written. A name this build does not have is
 * refused here, before the port writes the settings or the page asks the human.
 */
export const answerPlugins = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  gate: PluginsGate,
): Promise<boolean> => {
  if (path !== '/plugins') return false
  const method = request.method
  if (method !== 'GET' && method !== 'POST') {
    refuse(response, 405, 'method not allowed')
    return true
  }
  if (!gated(request, response, gate)) return true
  if (method === 'GET') {
    answerView(response, gate.plugins.view())
    return true
  }
  await answerChange(request, response, gate)
  return true
}
