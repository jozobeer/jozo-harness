import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/**
 * The SEA asset store, when the runtime has one. A compiled binary carries the
 * built page under `web/`; a run from the tree reads it from disk.
 */
const sea = await import('node:sea').catch(() => undefined)

const TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
])

const typeOf = (path: string): string => {
  const index = path.lastIndexOf('.')
  return (index < 0 ? undefined : TYPES.get(path.slice(index))) ?? 'application/octet-stream'
}

/** The part of a request path a file is read under, or undefined when it must be refused. */
const relativeOf = (requestPath: string): string | undefined => {
  const decoded = ((): string | undefined => {
    try {
      return decodeURIComponent(requestPath)
    } catch {
      return undefined
    }
  })()
  if (decoded === undefined || decoded.includes('\u0000')) return undefined
  const stripped = decoded.replace(/^\/+/, '')
  // A directory request serves the page in it, the way a static server does.
  return stripped === '' || stripped.endsWith('/') ? stripped + 'index.html' : stripped
}

/**
 * Resolves a request path inside `root`, or undefined when it escapes it.
 * The check runs after decoding, so `%2e%2e` cannot climb either.
 */
export const staticPath = (root: string, requestPath: string): string | undefined => {
  const relative = relativeOf(requestPath)
  if (relative === undefined) return undefined
  const base = resolve(root)
  const candidate = resolve(join(base, relative))
  return candidate === base || candidate.startsWith(base + sep) ? candidate : undefined
}

/**
 * The headers a file answers with. The page is opened from a URL that carries
 * the startup token until its script strips it, so the page may not name that
 * address to another request and may not wait in a cache.
 */
const headersOf = (path: string): Record<string, string> =>
  path.endsWith('.html')
    ? {
        'content-type': typeOf(path),
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      }
    : { 'content-type': typeOf(path) }

/** The page a compiled binary carries, or undefined when this run is not one. */
const assetResponse = (requestPath: string): Response | undefined => {
  if (sea === undefined || !sea.isSea()) return undefined
  const relative = relativeOf(requestPath)
  if (relative === undefined) return undefined
  try {
    return new Response(sea.getAsset('web/' + relative), {
      headers: headersOf(relative),
    })
  } catch {
    return undefined
  }
}

/** Whether a page this process can serve is there: an asset when compiled, a file otherwise. */
export const pageIsThere = async (root: string): Promise<boolean> => {
  if (assetResponse('/') !== undefined) return true
  const path = staticPath(root, '/')
  if (path === undefined) return false
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  )
}

/** The file a browser asked for, or undefined when it does not exist. */
export const staticResponse = async (
  root: string,
  requestPath: string,
): Promise<Response | undefined> => {
  const fromAsset = assetResponse(requestPath)
  if (fromAsset !== undefined) return fromAsset
  const path = staticPath(root, requestPath)
  if (path === undefined) return undefined
  const info = await stat(path).then(
    (value) => value,
    () => undefined,
  )
  if (info === undefined || !info.isFile()) return undefined
  return new Response(await readFile(path), { headers: headersOf(path) })
}
