import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import {
  codeFromUrl,
  COOKIE_NAME,
  cookieOf,
  originAllowed,
  tokenFromUrl,
  tokenMatches,
  type CodeExchange,
  type PublicOrigin,
} from './auth.ts'
import type { TailnetAddresses } from './tailnet.ts'

/**
 * Artifacts live beside the sessions root, under the same jzh home, so a
 * session's page and the HTML it wrote are found through one directory.
 */
export const artifactRootOf = (sessionRoot: string): string =>
  join(dirname(sessionRoot), 'artifacts')

/** A session id or artifact name the route may hand to the filesystem. */
const safeSegment = (value: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..')

/** Where `/artifact/<sessionId>/<name>` points, once the path names that route. */
type ArtifactRoute =
  | { readonly kind: 'other' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'file'; readonly sessionId: string; readonly name: string }

const routeOf = (path: string): ArtifactRoute => {
  if (!path.startsWith('/artifact/')) return { kind: 'other' }
  const [sessionId, name, ...rest] = path.slice('/artifact/'.length).split('/')
  const safe =
    sessionId !== undefined &&
    name !== undefined &&
    rest.length === 0 &&
    safeSegment(sessionId) &&
    safeSegment(name)
  return safe ? { kind: 'file', sessionId, name } : { kind: 'invalid' }
}

/** The gate the artifact route shares with the page: same host, origin, and token. */
export interface ArtifactGate {
  /** Absent when the run could not read where its sessions live. */
  readonly root: string | undefined
  readonly port: number
  readonly publicOrigin: PublicOrigin | undefined
  readonly tailnet: TailnetAddresses | undefined
  readonly token: string
  readonly codes: CodeExchange
}

/** The token either the cookie or the URL repeats, or a startup code still worth trading. */
const authorized = (request: IncomingMessage, gate: ArtifactGate): boolean => {
  const url = request.url ?? ''
  const offered = cookieOf(request.headers.cookie, COOKIE_NAME) ?? tokenFromUrl(url)
  return tokenMatches(offered, gate.token) || gate.codes.peek(codeFromUrl(url))
}

const refuse = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

/**
 * Answers the artifact route and reports whether it did. A path naming another
 * route is left to the page's own files. An artifact is HTML the run wrote, so
 * it is served under a sandbox without its origin and never sniffed.
 */
export const answerArtifact = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  gate: ArtifactGate,
): Promise<boolean> => {
  const route = routeOf(path)
  if (route.kind === 'other') return false
  if (route.kind === 'invalid') {
    refuse(response, 400, 'invalid artifact path')
    return true
  }
  if (request.method !== 'GET') {
    refuse(response, 405, 'method not allowed')
    return true
  }
  if (!originAllowed(request.headers.origin, gate.port, gate.publicOrigin, gate.tailnet)) {
    refuse(response, 403, 'forbidden')
    return true
  }
  if (!authorized(request, gate)) {
    refuse(response, 401, 'a token or a code is required')
    return true
  }
  const body =
    gate.root === undefined
      ? undefined
      : await readFile(join(gate.root, route.sessionId, route.name + '.html')).catch(
          () => undefined,
        )
  if (body === undefined) {
    refuse(response, 404, 'not found')
    return true
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': 'sandbox allow-scripts',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
  return true
}
