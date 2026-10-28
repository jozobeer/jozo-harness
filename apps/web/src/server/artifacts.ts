import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { originAllowed, requestAuthorized, type CodeExchange, type PublicOrigin } from './auth.ts'
import type { TailnetAddresses } from './tailnet.ts'

/** A session id or artifact name the route may hand to the filesystem. */
const safeSegment = (value: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..')

/** Where a path under `/artifact/` or `/artifacts/` points, once it names that route. */
type ArtifactRoute =
  | { readonly kind: 'other' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'list'; readonly sessionId: string }
  | { readonly kind: 'file'; readonly sessionId: string; readonly name: string }

const listRouteOf = (rest: string): ArtifactRoute => {
  const [sessionId, ...extra] = rest.split('/')
  return sessionId !== undefined && extra.length === 0 && safeSegment(sessionId)
    ? { kind: 'list', sessionId }
    : { kind: 'invalid' }
}

const fileRouteOf = (rest: string): ArtifactRoute => {
  const [sessionId, name, ...extra] = rest.split('/')
  const safe =
    sessionId !== undefined &&
    name !== undefined &&
    extra.length === 0 &&
    safeSegment(sessionId) &&
    safeSegment(name)
  return safe ? { kind: 'file', sessionId, name } : { kind: 'invalid' }
}

const routeOf = (path: string): ArtifactRoute => {
  if (path.startsWith('/artifacts/')) return listRouteOf(path.slice('/artifacts/'.length))
  if (path.startsWith('/artifact/')) return fileRouteOf(path.slice('/artifact/'.length))
  return { kind: 'other' }
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

const refuse = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

/** The methods each route answers: a list is read-only, a page may also be removed. */
const methodAllowed = (method: string | undefined, route: ArtifactRoute): boolean =>
  route.kind === 'file' ? method === 'GET' || method === 'DELETE' : method === 'GET'

/**
 * True when a delete came from this page's origin or a script that named a
 * header a plain form cannot set. A browser sends Origin on DELETE; the header
 * proves the same intent for a caller that is not a browser.
 */
const deleteConfirmed = (request: IncomingMessage, gate: ArtifactGate): boolean =>
  request.headers['x-requested-with'] !== undefined ||
  (request.headers.origin !== undefined &&
    originAllowed(request.headers.origin, gate.port, gate.publicOrigin, gate.tailnet))

/** True when the route's shared gate admits the request; a refusal has already been sent. */
const admitted = (
  request: IncomingMessage,
  response: ServerResponse,
  gate: ArtifactGate,
  route: ArtifactRoute,
): boolean => {
  if (!methodAllowed(request.method, route)) {
    refuse(response, 405, 'method not allowed')
    return false
  }
  if (!originAllowed(request.headers.origin, gate.port, gate.publicOrigin, gate.tailnet)) {
    refuse(response, 403, 'forbidden')
    return false
  }
  // A same-site GET is harmless; a delete must also prove the caller meant it.
  if (request.method === 'DELETE' && !deleteConfirmed(request, gate)) {
    refuse(response, 403, 'forbidden')
    return false
  }
  if (!requestAuthorized(request.url ?? '', request.headers.cookie, gate)) {
    refuse(response, 401, 'a token or a code is required')
    return false
  }
  return true
}

/** One artifact as the list names it: the route that opens it and what the file weighed. */
interface ArtifactEntry {
  readonly name: string
  readonly path: string
  readonly bytes: number
  readonly updatedAt: string
}

/** The file's entry, or nothing when a name that once listed has since been removed. */
const entryOf = (
  root: string,
  sessionId: string,
  file: string,
): Promise<ArtifactEntry | undefined> => {
  const name = file.slice(0, -'.html'.length)
  return stat(join(root, sessionId, file)).then(
    (info) =>
      info.isFile()
        ? {
            name,
            path: `/artifact/${sessionId}/${name}`,
            bytes: info.size,
            updatedAt: info.mtime.toISOString(),
          }
        : undefined,
    () => undefined,
  )
}

/** The session's artifacts in name order; a directory that is not there yet holds none. */
const listOf = async (root: string, sessionId: string): Promise<ReadonlyArray<ArtifactEntry>> => {
  const files = await readdir(join(root, sessionId)).catch(() => [])
  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith('.html') && safeSegment(file.slice(0, -'.html'.length)))
      .map((file) => entryOf(root, sessionId, file)),
  )
  return entries
    .filter((entry): entry is ArtifactEntry => entry !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name))
}

const answerList = async (
  response: ServerResponse,
  root: string | undefined,
  sessionId: string,
): Promise<void> => {
  const entries = root === undefined ? [] : await listOf(root, sessionId)
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(entries))
}

/** Removes one page; a name that is not there, or a root that is unknown, is a miss. */
const answerDelete = async (
  response: ServerResponse,
  root: string | undefined,
  sessionId: string,
  name: string,
): Promise<void> => {
  const removed =
    root !== undefined &&
    (await unlink(join(root, sessionId, name + '.html')).then(
      () => true,
      () => false,
    ))
  if (!removed) {
    refuse(response, 404, 'not found')
    return
  }
  response.writeHead(204)
  response.end()
}

/** True when the request asked for the page as a file instead of as a tab. */
const wantsDownload = (request: IncomingMessage): boolean =>
  new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('download') === '1'

const answerFile = async (
  request: IncomingMessage,
  response: ServerResponse,
  root: string | undefined,
  sessionId: string,
  name: string,
): Promise<void> => {
  const body =
    root === undefined
      ? undefined
      : await readFile(join(root, sessionId, name + '.html')).catch(() => undefined)
  if (body === undefined) {
    refuse(response, 404, 'not found')
    return
  }
  // The same bytes under the same gate; a download only asks the browser to save them.
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': 'sandbox allow-scripts',
    'x-content-type-options': 'nosniff',
    ...(wantsDownload(request)
      ? { 'content-disposition': 'attachment; filename="' + name + '.html"' }
      : {}),
  })
  response.end(body)
}

/**
 * Answers the artifact routes and reports whether it did. A path naming another
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
  if (!admitted(request, response, gate, route)) return true
  if (route.kind === 'list') await answerList(response, gate.root, route.sessionId)
  else if (request.method === 'DELETE') {
    await answerDelete(response, gate.root, route.sessionId, route.name)
  } else {
    await answerFile(request, response, gate.root, route.sessionId, route.name)
  }
  return true
}
