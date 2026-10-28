import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bypassesProxy, outboundFetch, proxyFor, readProxySettings } from '../src/index.ts'

interface Received {
  readonly url: string
  readonly method: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

interface Answer {
  readonly status: number
  readonly body: string
  readonly headers?: Readonly<Record<string, string>>
}

const startServer = async (
  handle: (request: Received) => Answer,
): Promise<{
  origin: string
  received: Received[]
  connects: string[]
  stop: () => Promise<void>
}> => {
  const received: Received[] = []
  const connects: string[] = []
  const server: Server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const request = {
        url: incoming.url ?? '',
        method: incoming.method ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      received.push(request)
      const answer = handle(request)
      response.writeHead(answer.status, {
        'content-type': 'text/plain; charset=utf-8',
        ...answer.headers,
      })
      response.end(answer.body)
    })
  })
  server.on('connect', (request, socket) => {
    connects.push(request.url ?? '')
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  return {
    origin: 'http://127.0.0.1:' + String(port),
    received,
    connects,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

beforeEach(() => {
  vi.stubEnv('HTTP_PROXY', '')
  vi.stubEnv('HTTPS_PROXY', '')
  vi.stubEnv('NO_PROXY', '')
  vi.stubEnv('http_proxy', '')
  vi.stubEnv('https_proxy', '')
  vi.stubEnv('no_proxy', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('proxy settings', () => {
  test('reads the upper case spelling first and the lower case as a fallback', () => {
    expect(readProxySettings({ HTTP_PROXY: 'http://upper', http_proxy: 'http://lower' })).toEqual({
      httpProxy: 'http://upper',
    })
    expect(readProxySettings({ https_proxy: 'http://lower' })).toEqual({
      httpsProxy: 'http://lower',
    })
    expect(readProxySettings({ NO_PROXY: '.example.com' })).toEqual({ noProxy: '.example.com' })
  })

  test('leaves the settings empty when nothing is exported', () => {
    expect(readProxySettings({})).toEqual({})
    expect(readProxySettings({ HTTP_PROXY: '' })).toEqual({})
  })

  test('picks HTTPS_PROXY for an https target and HTTP_PROXY for plain http', () => {
    const settings = {
      httpProxy: 'http://http-proxy:3128',
      httpsProxy: 'http://secure-proxy:3128',
    }
    expect(proxyFor(settings, new URL('https://api.example.com/v1'))?.href).toBe(
      'http://secure-proxy:3128/',
    )
    expect(proxyFor(settings, new URL('http://plain.example.com/'))?.href).toBe(
      'http://http-proxy:3128/',
    )
  })

  test('connects directly when the matching variable is unset', () => {
    expect(
      proxyFor({ httpProxy: 'http://http-proxy:3128' }, new URL('https://a.example.com/')),
    ).toBeUndefined()
    expect(proxyFor({}, new URL('https://a.example.com/'))).toBeUndefined()
  })

  test('fails with the variable name when the proxy value is not a URL', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://[not-a-host')
    await expect(outboundFetch('https://api.example.com/v1')).rejects.toThrow(
      /HTTPS_PROXY is not a usable proxy URL/,
    )
  })
})

describe('NO_PROXY matching', () => {
  test('matches an exact host, a leading-dot suffix and every host under a bare suffix', () => {
    expect(bypassesProxy('api.example.com', 'api.example.com', '443')).toBe(true)
    expect(bypassesProxy('.example.com', 'api.example.com', '443')).toBe(true)
    expect(bypassesProxy('example.com', 'api.example.com', '443')).toBe(true)
    expect(bypassesProxy('api.example.com', 'other.example.com', '443')).toBe(false)
  })

  test('matches a port-qualified entry only on that port', () => {
    expect(bypassesProxy('127.0.0.1:8080', '127.0.0.1', '8080')).toBe(true)
    expect(bypassesProxy('127.0.0.1:8080', '127.0.0.1', '9090')).toBe(false)
  })

  test('matches every host for a star and ignores case and blank entries', () => {
    expect(bypassesProxy('*', 'anything.example', '443')).toBe(true)
    expect(bypassesProxy(' API.Example.COM , ', 'api.example.com', '443')).toBe(true)
    expect(bypassesProxy('', 'api.example.com', '443')).toBe(false)
    expect(bypassesProxy(undefined, 'api.example.com', '443')).toBe(false)
  })
})

describe('outbound fetch', () => {
  test('sends an http request through the proxy in absolute URI form', async () => {
    const proxy = await startServer(() => ({ status: 200, body: 'through the proxy' }))
    vi.stubEnv('HTTP_PROXY', proxy.origin)

    const response = await outboundFetch('http://upstream.example/hello?x=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })

    expect(await response.text()).toBe('through the proxy')
    expect(proxy.received).toHaveLength(1)
    expect(proxy.received[0]?.url).toBe('http://upstream.example/hello?x=1')
    expect(proxy.received[0]?.method).toBe('POST')
    expect(proxy.received[0]?.body).toBe('{"a":1}')
    expect(proxy.received[0]?.headers.host).toBe('upstream.example')
    await proxy.stop()
  })

  test('goes straight out for a host NO_PROXY names', async () => {
    const direct = await startServer(() => ({ status: 200, body: 'direct' }))
    const proxy = await startServer(() => ({ status: 200, body: 'proxied' }))
    vi.stubEnv('HTTP_PROXY', proxy.origin)
    vi.stubEnv('NO_PROXY', '127.0.0.1')

    const response = await outboundFetch(direct.origin + '/')

    expect(await response.text()).toBe('direct')
    expect(proxy.received).toHaveLength(0)
    await proxy.stop()
    await direct.stop()
  })

  test('uses the lower case spelling when the upper case one is absent', async () => {
    const proxy = await startServer(() => ({ status: 200, body: 'lower case' }))
    vi.stubEnv('http_proxy', proxy.origin)

    const response = await outboundFetch('http://upstream.example/')

    expect(await response.text()).toBe('lower case')
    expect(proxy.received).toHaveLength(1)
    await proxy.stop()
  })

  test('connects directly when no proxy variable is set', async () => {
    const direct = await startServer(() => ({ status: 200, body: 'no proxy' }))
    const response = await outboundFetch(direct.origin + '/')
    expect(await response.text()).toBe('no proxy')
    await direct.stop()
  })

  test('follows a redirect and turns a redirected POST into a bodyless GET', async () => {
    const proxy = await startServer((request) =>
      request.url === 'http://upstream.example/start'
        ? { status: 302, body: '', headers: { location: 'http://upstream.example/end' } }
        : { status: 200, body: 'landed' },
    )
    vi.stubEnv('HTTP_PROXY', proxy.origin)

    const response = await outboundFetch('http://upstream.example/start', {
      method: 'POST',
      body: 'payload',
    })

    expect(await response.text()).toBe('landed')
    expect(proxy.received.map((request) => [request.url, request.method, request.body])).toEqual([
      ['http://upstream.example/start', 'POST', 'payload'],
      ['http://upstream.example/end', 'GET', ''],
    ])
    await proxy.stop()
  })

  test('carries proxy credentials from the variable as a Basic header', async () => {
    const proxy = await startServer(() => ({ status: 200, body: 'ok' }))
    vi.stubEnv('HTTP_PROXY', proxy.origin.replace('http://', 'http://alice:s3cret@'))

    await outboundFetch('http://upstream.example/')

    expect(proxy.received[0]?.headers['proxy-authorization']).toBe(
      'Basic ' + Buffer.from('alice:s3cret').toString('base64'),
    )
    await proxy.stop()
  })

  test('returns a 204 response without a body', async () => {
    const proxy = await startServer(() => ({ status: 204, body: '' }))
    vi.stubEnv('HTTP_PROXY', proxy.origin)

    const response = await outboundFetch('http://upstream.example/empty')

    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    await proxy.stop()
  })

  test('tunnels an https target through CONNECT and reports a refusal with its reason', async () => {
    const proxy = await startServer(() => ({ status: 500, body: 'unused' }))
    vi.stubEnv('HTTPS_PROXY', proxy.origin)

    await expect(outboundFetch('https://api.example.com/v1/messages')).rejects.toThrow(
      /proxy refused CONNECT to api\.example\.com:443 with HTTP 403/,
    )
    expect(proxy.connects).toEqual(['api.example.com:443'])
    await proxy.stop()
  })
})
