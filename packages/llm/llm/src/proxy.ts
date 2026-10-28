/**
 * Outbound HTTP through the proxy the launching environment names.
 *
 * Node's fetch ignores HTTP_PROXY, HTTPS_PROXY and NO_PROXY, so every module
 * that reaches the network calls `outboundFetch` instead. It reads the
 * variables per call, which keeps a process that was started with a proxy
 * consistent with one that exports it later, and routes through a forward
 * proxy: an http target travels in absolute URI form, an https target rides a
 * CONNECT tunnel the proxy opens.
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

/** The proxy variables a launching environment may carry. */
export interface ProxySettings {
  readonly httpProxy?: string
  readonly httpsProxy?: string
  readonly noProxy?: string
}

/** The environment shape readProxySettings takes; process.env fits it. */
export type ProxyEnvironment = Record<string, string | undefined>

/** Redirects a proxied call follows before it gives up, matching fetch's own budget. */
const MAX_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** The first of the upper- and lower-case spellings that holds a value. */
const envValue = (env: ProxyEnvironment, name: string): string | undefined => {
  const upper = env[name]
  if (upper !== undefined && upper !== '') return upper
  const lower = env[name.toLowerCase()]
  return lower === undefined || lower === '' ? undefined : lower
}

/** Reads the proxy variables, upper case winning over lower case. */
export const readProxySettings = (env: ProxyEnvironment = process.env): ProxySettings => {
  const httpProxy = envValue(env, 'HTTP_PROXY')
  const httpsProxy = envValue(env, 'HTTPS_PROXY')
  const noProxy = envValue(env, 'NO_PROXY')
  return {
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  }
}

/** The port a URL reaches, spelled the way NO_PROXY entries spell it. */
const portOf = (url: URL): string =>
  url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'

/** One NO_PROXY entry against a target; a leading dot and a port are allowed. */
const entryMatches = (entry: string, hostname: string, port: string): boolean => {
  if (entry === '*') return true
  const colon = entry.lastIndexOf(':')
  const namedPort = colon > 0 && /^[0-9]+$/.test(entry.slice(colon + 1))
  if (namedPort && entry.slice(colon + 1) !== port) return false
  const host = (namedPort ? entry.slice(0, colon) : entry).replace(/^\./, '')
  const name = hostname.toLowerCase()
  return host !== '' && (name === host || name.endsWith('.' + host))
}

/** Whether NO_PROXY exempts this host and port from the proxy. */
export const bypassesProxy = (
  noProxy: string | undefined,
  hostname: string,
  port: string,
): boolean =>
  noProxy !== undefined &&
  noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry !== '' && entryMatches(entry, hostname, port))

/** Parses one proxy value, naming the variable when it is unusable. */
const proxyUrlOf = (raw: string, name: string): URL => {
  const spelled = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw
  let url: URL
  try {
    url = new URL(spelled)
  } catch {
    throw new Error(name + ' is not a usable proxy URL: ' + raw)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(name + ' names a proxy over an unsupported protocol: ' + raw)
  }
  return url
}

/** The proxy a target goes through, or undefined when it goes straight out. */
export const proxyFor = (settings: ProxySettings, target: URL): URL | undefined => {
  if (bypassesProxy(settings.noProxy, target.hostname, portOf(target))) return undefined
  const secure = target.protocol === 'https:'
  const raw = secure ? settings.httpsProxy : settings.httpProxy
  return raw === undefined ? undefined : proxyUrlOf(raw, secure ? 'HTTPS_PROXY' : 'HTTP_PROXY')
}

/** Proxy credentials as a Basic header, only when the URL carries them. */
const authorizationOf = (proxy: URL): http.OutgoingHttpHeaders => {
  if (proxy.username === '') return {}
  const credentials = decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)
  return { 'proxy-authorization': 'Basic ' + Buffer.from(credentials).toString('base64') }
}

/** Request headers as node wants them; compression stays off so a body is readable as sent. */
const headersOf = (init: RequestInit | undefined, host: string): http.OutgoingHttpHeaders => {
  const headers: http.OutgoingHttpHeaders = {}
  new Headers(init?.headers).forEach((value, name) => {
    if (name !== 'host' && name !== 'accept-encoding') headers[name] = value
  })
  return { ...headers, host, 'accept-encoding': 'identity' }
}

/** The request body when the proxy path can carry it; the call sites send text. */
const bodyOf = (init: RequestInit | undefined): string | Buffer | undefined => {
  const body = init?.body
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  throw new Error('the proxy path cannot send this request body')
}

/** The response body as a web stream, so the web Response can carry it. */
const bodyStreamOf = (incoming: http.IncomingMessage): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      incoming.on('end', () => controller.close())
      incoming.on('error', (error: Error) => controller.error(error))
    },
    cancel() {
      incoming.destroy()
    },
  })

/** A node response's headers in the web shape. */
const incomingHeadersOf = (incoming: http.IncomingMessage): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return headers
}

/** A node response as the web Response the call sites read. */
const responseOf = (incoming: http.IncomingMessage): Response => {
  const status = incoming.statusCode ?? 502
  const headers = incomingHeadersOf(incoming)
  // 204 and 304 must not carry a body, and the web Response refuses one.
  if (status === 204 || status === 304) {
    incoming.resume()
    return new Response(null, { status, headers })
  }
  return new Response(bodyStreamOf(incoming), {
    status,
    statusText: incoming.statusMessage ?? '',
    headers,
  })
}

/** Sends one http target to the proxy in absolute URI form. */
const sendInAbsoluteForm = (
  proxy: URL,
  target: URL,
  init: RequestInit | undefined,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http
    const request = transport.request(
      {
        host: proxy.hostname,
        port: Number(portOf(proxy)),
        method: init?.method ?? 'GET',
        // The absolute form is what tells a forward proxy where to go.
        path: target.href.replace(/#.*$/, ''),
        headers: { ...headersOf(init, target.host), ...authorizationOf(proxy) },
        ...(init?.signal === null || init?.signal === undefined ? {} : { signal: init.signal }),
      },
      (incoming) => resolve(responseOf(incoming)),
    )
    request.once('error', reject)
    request.end(bodyOf(init))
  })

/** Opens the CONNECT tunnel an https target needs. */
const tunnelTo = (proxy: URL, target: URL): Promise<tls.TLSSocket> =>
  new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http
    const authority = target.hostname + ':' + portOf(target)
    const request = transport.request({
      host: proxy.hostname,
      port: Number(portOf(proxy)),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...authorizationOf(proxy) },
      agent: false,
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(
          new Error(
            'the proxy refused CONNECT to ' +
              authority +
              ' with HTTP ' +
              String(response.statusCode),
          ),
        )
        return
      }
      resolve(tls.connect({ socket, servername: target.hostname }))
    })
    request.once('error', reject)
    request.end()
  })

/** Sends one https target over the tunnel the proxy opened. */
const sendOverTunnel = async (
  proxy: URL,
  target: URL,
  init: RequestInit | undefined,
): Promise<Response> => {
  const socket = await tunnelTo(proxy, target)
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: target.hostname,
        port: Number(portOf(target)),
        method: init?.method ?? 'GET',
        path: target.pathname + target.search,
        headers: headersOf(init, target.host),
        // The tunnel is already TLS, so hand the socket over instead of wrapping it again.
        createConnection: () => socket,
        agent: false,
        ...(init?.signal === null || init?.signal === undefined ? {} : { signal: init.signal }),
      },
      (incoming) => resolve(responseOf(incoming)),
    )
    request.once('error', reject)
    request.end(bodyOf(init))
  })
}

const sendThroughProxy = (
  proxy: URL,
  target: URL,
  init: RequestInit | undefined,
): Promise<Response> =>
  target.protocol === 'https:'
    ? sendOverTunnel(proxy, target, init)
    : sendInAbsoluteForm(proxy, target, init)

/** A redirected request keeps its method on 307 and 308 and drops the body otherwise. */
const redirectedInit = (init: RequestInit | undefined, status: number): RequestInit | undefined => {
  if (status === 307 || status === 308) return init
  if (init === undefined) return undefined
  const next: RequestInit = { ...init, method: 'GET' }
  delete next.body
  return next
}

const proxiedFetch = async (
  settings: ProxySettings,
  target: URL,
  init: RequestInit | undefined,
): Promise<Response> => {
  let current = target
  let request = init
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const proxy = proxyFor(settings, current)
    // A host NO_PROXY names, or a run with no proxy, goes out the way it always did.
    if (proxy === undefined) return fetch(current, request)
    const response = await sendThroughProxy(proxy, current, request)
    const location = response.headers.get('location')
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response
    await response.body?.cancel()
    current = new URL(location, current)
    request = redirectedInit(request, response.status)
  }
  throw new Error('the proxy path followed more redirects than it allows')
}

/** The URL a fetch input names, for the proxy decision. */
const targetOf = (input: Parameters<typeof fetch>[0]): URL =>
  new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)

/**
 * fetch, routed through the launching environment's proxy when it names one.
 * Callers pass the same input and init they would give fetch.
 */
export const outboundFetch: typeof fetch = (input, init) =>
  proxiedFetch(readProxySettings(), targetOf(input), init)
