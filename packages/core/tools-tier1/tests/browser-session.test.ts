import { createHash } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { Effect, Exit, Scope } from 'effect'
import { describe, expect, test } from 'vitest'
import type { ToolError } from '@jozo-harness/tools'
import {
  browserPrograms,
  browserSessionTools,
  connectCdp,
  makeBrowserSession,
  sessionBrowserCommand,
  systemBrowserSessionHost,
  type BrowserChild,
  type BrowserPage,
  type BrowserSessionHost,
  type BrowserSession,
  type BrowserTimeouts,
  type CdpConnection,
} from '../src/index.ts'

interface FakeOptions {
  /** The programs the host reports installed; empty means no chrome at all. */
  readonly programs?: ReadonlyArray<string>
  /** The page the fake snapshot script describes. */
  readonly page?: unknown
  /** Whether the fake click or type finds the selector. */
  readonly found?: boolean
  /** Whether Page.navigate reports a failure. */
  readonly navigateError?: string
  /** Whether Runtime.evaluate never answers, as a browser that stopped responding. */
  readonly silent?: boolean
}

interface FakeHost {
  readonly host: BrowserSessionHost
  /** The CDP socket the host hands out, so a failure test can wrap one method. */
  readonly connection: CdpConnection
  readonly spawns: Array<ReadonlyArray<string>>
  readonly removed: Array<string>
  readonly killed: Array<boolean>
  readonly calls: Array<{
    readonly method: string
    readonly params: Readonly<Record<string, unknown>>
  }>
}

const PAGE = {
  url: 'https://example.com/',
  title: 'Example',
  text: 'Hello\nWorld',
  elements: [{ selector: '#go', tag: 'button', role: 'button', name: 'Go' }],
}

/** A host that records what a session asked for and answers CDP from memory. */
const fakeHost = (options: FakeOptions = {}): FakeHost => {
  const programs = options.programs ?? ['chromium']
  const spawns: Array<ReadonlyArray<string>> = []
  const removed: Array<string> = []
  const killed: Array<boolean> = []
  const calls: Array<{
    readonly method: string
    readonly params: Readonly<Record<string, unknown>>
  }> = []
  let exit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    exit = resolve
  })
  const page = options.page ?? PAGE
  /** What the page script asked for: a snapshot or an action result. */
  const evaluated = (expression: string): unknown => {
    if (expression.includes('document.querySelectorAll')) return page
    return options.found === false ? { found: false } : { found: true, tag: 'button' }
  }
  const connection: CdpConnection = {
    send: (method, params) => {
      calls.push({ method, params })
      if (options.silent === true) return new Promise(() => {})
      if (method === 'Page.navigate') {
        return Promise.resolve(
          options.navigateError === undefined
            ? { frameId: 'frame-1' }
            : { errorText: options.navigateError },
        )
      }
      const expression = typeof params['expression'] === 'string' ? params['expression'] : ''
      if (expression === 'document.readyState') {
        return Promise.resolve({ result: { type: 'string', value: 'complete' } })
      }
      return Promise.resolve({
        result: { type: 'string', value: JSON.stringify(evaluated(expression)) },
      })
    },
    close: () => {},
  }
  return {
    host: {
      programs,
      hasProgram: (program) => programs.includes(program),
      makeTempDirectory: async () => '/tmp/jzh-browser-test',
      readTextFile: async () => '9222\n/devtools/browser/test',
      removeDirectory: async (path) => {
        removed.push(path)
      },
      fetchJson: async () => [
        { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1' },
      ],
      connect: async () => connection,
      spawn: (argv) => {
        spawns.push(argv)
        return {
          exited,
          stderr: async () => '',
          kill: () => {
            killed.push(true)
            exit(0)
          },
        }
      },
      sleep: async () => {},
    },
    connection,
    spawns,
    removed,
    killed,
    calls,
  }
}

interface Opened {
  readonly scope: Scope.Closeable
  readonly session: BrowserSession
  readonly tools: ReturnType<typeof browserSessionTools>
}

/** Builds a session in its own scope, the way a browser row is wired into a run. */
const openSession = async (
  host: BrowserSessionHost,
  timeouts: BrowserTimeouts = { startupMs: 1_000, navigationMs: 1_000, cdpMs: 100, pollMs: 1 },
): Promise<Opened> => {
  const scope = await Effect.runPromise(Scope.make())
  const session = await Effect.runPromise(
    makeBrowserSession(host, timeouts).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  return { scope, session, tools: browserSessionTools(session) }
}

const outcomeOf = <A>(effect: Effect.Effect<A, ToolError>) =>
  Effect.runPromise(
    Effect.match(effect, {
      onFailure: (error) => ({ value: undefined, error }),
      onSuccess: (value) => ({ value, error: undefined }),
    }),
  )

const tool = (opened: Opened, name: string) => {
  const found = opened.tools.find((each) => each.name === name)
  if (found === undefined) throw new Error('no tool named ' + name)
  return found
}

const context = { sessionId: 's1', cwd: '/work', callId: 'c1' }

describe('the session browser', () => {
  test('starts one chrome on the first open and reuses it for the second', async () => {
    const fake = fakeHost()
    const opened = await openSession(fake.host)
    const open = tool(opened, 'browser_open')

    const first = await outcomeOf(
      open.execute({ url: 'https://example.com/one' }, context as never),
    )
    const second = await outcomeOf(
      open.execute({ url: 'https://example.com/two' }, context as never),
    )

    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    expect(fake.spawns).toHaveLength(1)
    expect(fake.spawns[0]).toContain('--headless=new')
    expect(fake.spawns[0]).toContain('--remote-debugging-port=0')
    expect(fake.spawns[0]).toContain('--user-data-dir=/tmp/jzh-browser-test')
    expect(fake.spawns[0]).not.toContain('--dump-dom')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('returns the visible text and the elements a snapshot found', async () => {
    const fake = fakeHost()
    const opened = await openSession(fake.host)

    await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )
    const snapshot = await outcomeOf(tool(opened, 'browser_snapshot').execute({}, context as never))

    expect(snapshot.error).toBeUndefined()
    expect(snapshot.value).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      text: 'Hello\nWorld',
      truncated: false,
      elements: [{ selector: '#go', tag: 'button', role: 'button', name: 'Go' }],
    })
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('clicks the selector the model took from the snapshot', async () => {
    const fake = fakeHost()
    const opened = await openSession(fake.host)

    await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )
    const clicked = await outcomeOf(
      tool(opened, 'browser_click').execute({ selector: '#go' }, context as never),
    )

    expect(clicked.error).toBeUndefined()
    expect(clicked.value?.tag).toBe('button')
    const expression = fake.calls
      .filter((call) => call.method === 'Runtime.evaluate')
      .map((call) => call.params['expression'])
      .find((each): each is string => typeof each === 'string' && each.includes('el.click()'))
    expect(expression).toContain('"#go"')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('types into the selector the model took from the snapshot', async () => {
    const fake = fakeHost()
    const opened = await openSession(fake.host)

    await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )
    const typed = await outcomeOf(
      tool(opened, 'browser_type').execute(
        { selector: 'input[name=q]', text: 'search me' },
        context as never,
      ),
    )

    expect(typed.error).toBeUndefined()
    const expression = fake.calls
      .filter((call) => call.method === 'Runtime.evaluate')
      .map((call) => call.params['expression'])
      .find((each): each is string => typeof each === 'string' && each.includes('dispatchEvent'))
    expect(expression).toContain('search me')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('the end of the session kills the browser and removes its profile', async () => {
    const fake = fakeHost()
    const opened = await openSession(fake.host)

    await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))

    expect(fake.killed).toEqual([true])
    expect(fake.removed).toEqual(['/tmp/jzh-browser-test'])
  })

  test('a host without chrome returns unavailable and starts nothing', async () => {
    const fake = fakeHost()
    const host = {
      ...fake.host,
      programs: ['google-chrome', 'chromium'],
      hasProgram: () => false,
    }
    const opened = await openSession(host)

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toContain('google-chrome')
    expect(openedPage.error?.message).toContain('chromium')
    expect(fake.spawns).toHaveLength(0)
    expect(fake.removed).toEqual(['/tmp/jzh-browser-test'])
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a CDP socket that never answers fails as unavailable instead of holding the turn', async () => {
    const fake = fakeHost({ silent: true })
    const opened = await openSession(fake.host)

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
    expect(fake.killed).toContain(true)
  })

  test('a selector that names no element fails with execution', async () => {
    const fake = fakeHost({ found: false })
    const opened = await openSession(fake.host)

    await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )
    const clicked = await outcomeOf(
      tool(opened, 'browser_click').execute({ selector: '#missing' }, context as never),
    )

    expect(clicked.error?.code).toBe('execution')
    expect(clicked.error?.message).toContain('#missing')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a snapshot before any page says to call browser_open', async () => {
    const fake = fakeHost()
    const opened = await openSession(fake.host)

    const snapshot = await outcomeOf(tool(opened, 'browser_snapshot').execute({}, context as never))

    expect(snapshot.error?.code).toBe('execution')
    expect(snapshot.error?.message).toContain('browser_open')
    expect(fake.spawns).toHaveLength(0)
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a url that is not http(s) is refused before any chrome starts', async () => {
    const fake = fakeHost()
    const opened = await openSession(fake.host)

    for (const url of ['file:///etc/passwd', 'data:text/html,hi', 'not a url']) {
      const openedPage = await outcomeOf(
        tool(opened, 'browser_open').execute({ url }, context as never),
      )
      expect(openedPage.error?.code).toBe('invalid-arguments')
    }

    expect(fake.spawns).toHaveLength(0)
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('every browser tool is serialized so one page is not raced by two calls', async () => {
    const fake = fakeHost()
    const opened = await openSession(fake.host)

    for (const name of ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type']) {
      expect(tool(opened, name).isConcurrencySafe?.({})).toBe(false)
    }
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })
})

describe('sessionBrowserCommand', () => {
  test('starts headless chrome on a throwaway profile with a debugging port', () => {
    expect(sessionBrowserCommand('chromium', '/tmp/profile')).toEqual([
      'chromium',
      '--headless=new',
      '--remote-debugging-port=0',
      '--user-data-dir=/tmp/profile',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      'about:blank',
    ])
  })
})

/** The accept token a WebSocket handshake echoes, computed the way a server does. */
const acceptOf = (key: string): string =>
  createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')

/** One server-to-client frame. Frames a server sends are never masked. */
const serverFrame = (payload: Buffer, opcode: number): Buffer => {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.concat([
          Buffer.from([0x80 | opcode, 126]),
          Buffer.from([payload.length >> 8, payload.length & 0xff]),
        ])
  return Buffer.concat([header, payload])
}

const textFrame = (text: string): Buffer => serverFrame(Buffer.from(text, 'utf8'), 0x1)

const binaryFrame = (bytes: ReadonlyArray<number>): Buffer => serverFrame(Buffer.from(bytes), 0x2)

interface ParsedFrame {
  readonly opcode: number
  readonly payload: Buffer
  /** How many bytes of the buffer this frame took, so the reader can drop them. */
  readonly size: number
}

interface PayloadBounds {
  readonly masked: boolean
  readonly length: number
  /** Where the payload starts, before the mask key. */
  readonly offset: number
}

/** The length and start of a frame's payload, or undefined while its header is short. */
const payloadBounds = (buffered: Buffer): PayloadBounds | undefined => {
  if (buffered.length < 2) return undefined
  const second = buffered.readUInt8(1)
  const masked = (second & 0x80) !== 0
  if ((second & 0x7f) !== 126) return { masked, length: second & 0x7f, offset: 2 }
  return buffered.length < 4 ? undefined : { masked, length: buffered.readUInt16BE(2), offset: 4 }
}

/** Drops the key a client put over its payload; a client always masks. */
const unmasked = (payload: Buffer, key: Buffer): Buffer => {
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (payload[index] ?? 0) ^ (key[index % 4] ?? 0)
  }
  return payload
}

/** One frame the client sent, or undefined while its bytes are still arriving. */
const frameIn = (buffered: Buffer): ParsedFrame | undefined => {
  const bounds = payloadBounds(buffered)
  if (bounds === undefined) return undefined
  const start = bounds.offset + (bounds.masked ? 4 : 0)
  if (buffered.length < start + bounds.length) return undefined
  const size = start + bounds.length
  const payload = Buffer.from(buffered.subarray(start, size))
  const key = buffered.subarray(bounds.offset, start)
  return {
    opcode: buffered.readUInt8(0) & 0x0f,
    payload: bounds.masked ? unmasked(payload, key) : payload,
    size,
  }
}

/**
 * Reads the frames a client sends. A client masks every payload, so the
 * unmasking here is the half of the protocol the browser would own.
 */
const readFrames = (socket: Duplex, onFrame: (opcode: number, payload: Buffer) => void): void => {
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      const frame = frameIn(buffered)
      if (frame === undefined) return
      buffered = buffered.subarray(frame.size)
      onFrame(frame.opcode, frame.payload)
    }
  })
}

interface StubServer {
  readonly url: string
  readonly close: () => Promise<void>
}

/** A WebSocket server on a random port, answering an upgrade the way chrome does. */
const wsServer = async (
  onSocket: (socket: Duplex, accept: () => void) => void,
): Promise<StubServer> => {
  const server = createServer()
  // An upgraded socket leaves the http server's own tracking, so the test owns
  // the close: otherwise server.close waits on a client that waits on a close frame.
  const sockets = new Set<Duplex>()
  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const key = request.headers['sec-websocket-key']
    const accept = (): void => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          acceptOf(typeof key === 'string' ? key : '') +
          '\r\n\r\n',
      )
    }
    onSocket(socket, accept)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: 'ws://127.0.0.1:' + String(port) + '/devtools/page/1',
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/** A server that takes the connection and never finishes the handshake, as a stuck browser does. */
const stalledServer = async (): Promise<StubServer> => {
  const sockets = new Set<Socket>()
  const server = createNetServer((socket) => {
    sockets.add(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: 'ws://127.0.0.1:' + String(port) + '/devtools/page/1',
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/** The reply a server writes for one request frame, keyed to the id the client chose. */
const replyFrame = (payload: Buffer, result: unknown): Buffer => {
  const request = JSON.parse(payload.toString('utf8')) as { id: number }
  return textFrame(JSON.stringify({ id: request.id, result }))
}

describe('the CDP socket', () => {
  test('connectCdp resolves the result of a command it sent to the browser', async () => {
    const methods: Array<string> = []
    const server = await wsServer((socket, accept) => {
      accept()
      readFrames(socket, (opcode, payload) => {
        if (opcode !== 0x1) return
        const request = JSON.parse(payload.toString('utf8')) as { method: string }
        methods.push(request.method)
        socket.write(replyFrame(payload, { frameId: 'frame-1' }))
      })
    })

    const connection = await connectCdp(server.url, 1_000)
    const result = await connection.send('Page.navigate', { url: 'https://example.com/' })

    expect(result).toEqual({ frameId: 'frame-1' })
    expect(methods).toEqual(['Page.navigate'])
    connection.close()
    await server.close()
  })

  test('connectCdp rejects a call with the protocol error the browser sent', async () => {
    const server = await wsServer((socket, accept) => {
      accept()
      readFrames(socket, (opcode, payload) => {
        if (opcode !== 0x1) return
        const request = JSON.parse(payload.toString('utf8')) as { id: number }
        socket.write(
          textFrame(
            JSON.stringify({
              id: request.id,
              error: { code: -32601, message: 'method not found' },
            }),
          ),
        )
      })
    })

    const connection = await connectCdp(server.url, 1_000)

    await expect(connection.send('Page.navigate', {})).rejects.toThrow('method not found')
    connection.close()
    await server.close()
  })

  test('connectCdp ignores frames that cannot answer a waiting call', async () => {
    const server = await wsServer((socket, accept) => {
      accept()
      readFrames(socket, (opcode, payload) => {
        if (opcode !== 0x1) return
        socket.write(binaryFrame([0x00, 0x01]))
        socket.write(textFrame('not json at all'))
        socket.write(textFrame('null'))
        socket.write(textFrame('[{"id":1}]'))
        socket.write(textFrame('{"id":"1","result":{}}'))
        socket.write(textFrame('{"id":7,"result":{}}'))
        socket.write(replyFrame(payload, { ok: true }))
      })
    })

    const connection = await connectCdp(server.url, 1_000)
    const result = await connection.send('Runtime.evaluate', {})

    expect(result).toEqual({ ok: true })
    connection.close()
    await server.close()
  })

  test('connectCdp fails every waiting call when the socket closes', async () => {
    const server = await wsServer((socket, accept) => {
      accept()
      readFrames(socket, () => {
        socket.destroy()
      })
    })

    const connection = await connectCdp(server.url, 1_000)
    const first = connection.send('Page.navigate', {})
    const second = connection.send('Runtime.evaluate', {})

    await expect(first).rejects.toThrow('the CDP socket closed')
    await expect(second).rejects.toThrow('the CDP socket closed')
    await server.close()
  })

  test('connectCdp reports a socket the browser refused', async () => {
    const server = await wsServer((socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })

    await expect(connectCdp(server.url, 1_000)).rejects.toThrow('the CDP socket failed to open')
    await server.close()
  })

  test('connectCdp gives up on a handshake the browser never finishes', async () => {
    const server = await stalledServer()

    await expect(connectCdp(server.url, 50)).rejects.toThrow('timed out opening the CDP socket')
    await server.close()
  })

  test('connectCdp times out a call the browser never answers', async () => {
    const server = await wsServer((_socket, accept) => {
      accept()
    })

    const connection = await connectCdp(server.url, 50)

    await expect(connection.send('Runtime.evaluate', {})).rejects.toThrow(
      'timed out waiting for Runtime.evaluate',
    )
    connection.close()
    await server.close()
  })
})

describe('the system browser host', () => {
  test('reads the DevTools target list from a local endpoint', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify([
          { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/1' },
        ]),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const targets = await systemBrowserSessionHost.fetchJson(
      'http://127.0.0.1:' + String(port) + '/json/list',
    )

    expect(targets).toEqual([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/1' },
    ])
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('names the status when the DevTools endpoint answers with an error', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500)
      response.end('no targets')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    await expect(
      systemBrowserSessionHost.fetchJson('http://127.0.0.1:' + String(port) + '/json/list'),
    ).rejects.toThrow('the DevTools endpoint answered 500')
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('the system host makes a profile directory, reads a file in it, and removes it', async () => {
    const profile = await systemBrowserSessionHost.makeTempDirectory()
    const portFile = join(profile, 'DevToolsActivePort')
    await writeFile(portFile, '9222\n/devtools/browser/one', 'utf8')

    expect(await systemBrowserSessionHost.readTextFile(portFile)).toBe(
      '9222\n/devtools/browser/one',
    )

    await systemBrowserSessionHost.removeDirectory(profile)
    await expect(access(profile)).rejects.toThrow()
  })

  test('the system host runs a command and reads what it wrote to stderr', async () => {
    const child = systemBrowserSessionHost.spawn(
      [process.execPath, '-e', "process.stderr.write('why it stopped'); process.exit(3)"],
      process.cwd(),
    )

    expect(await child.exited).toBe(3)
    expect((await child.stderr()).trim()).toBe('why it stopped')
  })

  test('the system host kills a command that would otherwise keep running', async () => {
    const child = systemBrowserSessionHost.spawn(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
    )
    // The signal reaches the group only once the child is a process, so the
    // kill waits a turn rather than racing the spawn.
    await systemBrowserSessionHost.sleep(100)
    child.kill()

    expect(await child.exited).toBeGreaterThan(0)
  })

  test('the system host waits for the delay it was given', async () => {
    const started = Date.now()

    await systemBrowserSessionHost.sleep(20)

    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  test('the system host offers the chrome builds of this platform', () => {
    expect(systemBrowserSessionHost.programs).toEqual(browserPrograms(process.platform))
    expect(systemBrowserSessionHost.hasProgram('jzh-no-such-browser-program')).toBe(false)
  })
})

/** The step of starting chrome a failure test breaks. */
type Failure =
  | 'makeTempDirectory'
  | 'spawn'
  | 'fetchJson'
  | 'connect'
  | 'navigate'
  | 'evaluate'
  | 'exit'
  | 'removeDirectory'

/** A host whose one step fails, so a test reads the message a run would show. */
const hostFailingAt = (fake: FakeHost, step: Failure): BrowserSessionHost => {
  const broken: Record<Failure, () => BrowserSessionHost> = {
    makeTempDirectory: () => ({
      ...fake.host,
      makeTempDirectory: async () => {
        throw new Error('permission denied')
      },
    }),
    spawn: () => ({
      ...fake.host,
      spawn: () => {
        throw new Error('spawn chromium ENOENT')
      },
    }),
    fetchJson: () => ({
      ...fake.host,
      fetchJson: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    }),
    connect: () => ({
      ...fake.host,
      connect: async () => {
        throw new Error('the handshake was refused')
      },
    }),
    navigate: () => socketRefusing(fake, 'Page.navigate'),
    evaluate: () => socketRefusing(fake, 'Runtime.evaluate'),
    exit: () => ({ ...fake.host, spawn: (argv, cwd) => lostExit(fake, argv, cwd) }),
    removeDirectory: () => busyProfile(fake),
  }
  return broken[step]()
}

/** A socket whose one method rejects, the way a browser that went away answers. */
const socketRefusing = (fake: FakeHost, failing: string): BrowserSessionHost => ({
  ...fake.host,
  connect: async () => ({
    send: (method, params) =>
      method === failing
        ? Promise.reject(new Error('the socket is gone'))
        : fake.connection.send(method, params),
    close: () => {},
  }),
})

/** A child whose exit never arrives, as a browser that ignores its kill leaves it. */
const lostExit = (fake: FakeHost, argv: ReadonlyArray<string>, cwd: string): BrowserChild => {
  const child = fake.host.spawn(argv, cwd)
  const exited = new Promise<number>((_resolve, reject) => {
    setTimeout(() => reject(new Error('the child is gone')), 10)
  })
  // The session reads the exit only at close, so this keeps Node from
  // reporting the rejection as unhandled before that.
  exited.catch(() => {})
  return { ...child, exited }
}

/** A profile the browser still holds open, so the first removal fails. */
const busyProfile = (fake: FakeHost): BrowserSessionHost => {
  let attempts = 0
  return {
    ...fake.host,
    removeDirectory: async (path) => {
      attempts += 1
      if (attempts === 1) throw new Error('EBUSY')
      await fake.host.removeDirectory(path)
    },
  }
}

/** A host whose browser writes no port, with either a reason or a broken stderr. */
const hostWithoutPort = (fake: FakeHost, stderr: 'reason' | 'error'): BrowserSessionHost => ({
  ...fake.host,
  readTextFile: async () => 'not a port\n',
  spawn: (argv, cwd) => {
    const child = fake.host.spawn(argv, cwd)
    return {
      ...child,
      stderr:
        stderr === 'reason'
          ? async () => 'chrome: cannot open display\n'
          : async () => {
              throw new Error('the stream is gone')
            },
    }
  },
})

/** A host whose browser swallows the snapshot script, as a hung page does. */
const hostWithHangingPage = (fake: FakeHost): BrowserSessionHost => ({
  ...fake.host,
  connect: async () => ({
    send: (method, params) => {
      const expression = typeof params['expression'] === 'string' ? params['expression'] : ''
      return expression.includes('document.querySelectorAll')
        ? new Promise(() => {})
        : fake.connection.send(method, params)
    },
    close: () => {},
  }),
})

describe('a browser that fails while it starts', () => {
  test('a profile the host cannot make fails as unavailable before chrome starts', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostFailingAt(fake, 'makeTempDirectory'))

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toContain('temporary profile')
    expect(fake.spawns).toHaveLength(0)
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('chrome that cannot be spawned fails as unavailable and leaves no profile', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostFailingAt(fake, 'spawn'))

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toContain('spawn chromium ENOENT')
    expect(fake.removed).toEqual(['/tmp/jzh-browser-test'])
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a debugging port that refuses the target list fails as unavailable', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostFailingAt(fake, 'fetchJson'))

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toContain('debugging port')
    expect(fake.killed).toContain(true)
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a CDP handshake the browser refuses fails as unavailable', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostFailingAt(fake, 'connect'))

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toContain('CDP connection')
    expect(fake.killed).toContain(true)
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a browser that writes no DevToolsActivePort says why it stopped', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostWithoutPort(fake, 'reason'), {
      startupMs: 20,
      navigationMs: 20,
      cdpMs: 100,
      pollMs: 1,
    })

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toContain('DevToolsActivePort')
    expect(openedPage.error?.message).toContain('chrome: cannot open display')
    expect(fake.killed).toContain(true)
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a browser whose stderr cannot be read still reports the missing port', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostWithoutPort(fake, 'error'), {
      startupMs: 20,
      navigationMs: 20,
      cdpMs: 100,
      pollMs: 1,
    })

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toContain('no DevToolsActivePort')
    expect(openedPage.error?.message).not.toContain('the stream is gone')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })
})

describe('a browser that fails while it works', () => {
  test('a navigation the socket rejects fails as unavailable', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostFailingAt(fake, 'navigate'))

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toBe('browser did not answer in time')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a page script the socket rejects fails as unavailable', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostFailingAt(fake, 'evaluate'))

    const openedPage = await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )

    expect(openedPage.error?.code).toBe('unavailable')
    expect(openedPage.error?.message).toBe('browser did not answer within 100ms')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('a page that never answers fails as unavailable within the call timeout', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostWithHangingPage(fake))

    await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )
    const snapshot = await outcomeOf(tool(opened, 'browser_snapshot').execute({}, context as never))

    expect(snapshot.error?.code).toBe('unavailable')
    expect(snapshot.error?.message).toContain('did not answer within 100ms')
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))
  })

  test('closing the session still stops a browser that never reports its exit', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostFailingAt(fake, 'exit'))

    await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))

    expect(fake.killed).toEqual([true])
    expect(fake.removed).toEqual(['/tmp/jzh-browser-test'])
  })

  test('a profile that is busy at first is removed on the retry', async () => {
    const fake = fakeHost()
    const opened = await openSession(hostFailingAt(fake, 'removeDirectory'))

    await outcomeOf(
      tool(opened, 'browser_open').execute({ url: 'https://example.com/' }, context as never),
    )
    await Effect.runPromise(Scope.close(opened.scope, Exit.void))

    expect(fake.removed).toEqual(['/tmp/jzh-browser-test'])
  })
})

describe('the browser tools as the run pane reads them', () => {
  const page: BrowserPage = {
    url: 'https://example.com/',
    title: 'Example',
    text: 'Hello',
    truncated: true,
    elements: [
      { selector: '#go', tag: 'button', role: 'button', name: 'Go' },
      { selector: '#q', tag: 'input', role: 'textbox', name: '', value: 'x', disabled: true },
    ],
  }
  const opened = browserSessionTools({
    open: () => Effect.succeed(page),
    snapshot: () => Effect.succeed(page),
    click: (selector) =>
      Effect.succeed({ selector, tag: 'button', message: 'clicked button ' + selector }),
    type: (selector) =>
      Effect.succeed({ selector, tag: 'input', message: 'typed into input ' + selector }),
  })
  const named = (name: string) => {
    const found = opened.find((each) => each.name === name)
    if (found === undefined) throw new Error('no tool named ' + name)
    return found
  }

  test('browser_open renders the page text, the truncation note, and every element', () => {
    const rendered = named('browser_open').output.render({ url: page.url }, page)

    expect(rendered).toEqual([
      {
        type: 'text',
        text:
          'Hello\n… truncated\n\nclickable elements:\n' +
          '- #go (button) button "Go"\n' +
          '- #q (input) textbox disabled value="x"',
      },
    ])
  })

  test('a page with no clickable element says so instead of listing nothing', () => {
    const rendered = named('browser_snapshot').output.render(
      {},
      { ...page, truncated: false, elements: [] },
    )

    expect(rendered).toEqual([{ type: 'text', text: 'Hello\n\n(no clickable elements)' }])
  })

  test('browser_click and browser_type render what the call did', () => {
    const action = { selector: '#go', tag: 'button', message: 'clicked button #go' }

    expect(named('browser_click').output.render({ selector: '#go' }, action)).toEqual([
      { type: 'text', text: 'clicked button #go' },
    ])
    expect(named('browser_type').output.render({ selector: '#go', text: 'x' }, action)).toEqual([
      { type: 'text', text: 'clicked button #go' },
    ])
  })

  test('every browser tool names its call in the run pane', () => {
    expect(named('browser_open').presentCall?.({ url: 'https://example.com/' })).toEqual({
      summary: 'open https://example.com/',
    })
    expect(named('browser_snapshot').presentCall?.({})).toEqual({ summary: 'snapshot the page' })
    expect(named('browser_click').presentCall?.({ selector: '#go' })).toEqual({
      summary: 'click #go',
    })
    expect(named('browser_type').presentCall?.({ selector: '#q', text: 'x' })).toEqual({
      summary: 'type into #q',
    })
  })

  test('every browser tool names its result in the run pane', () => {
    const running = { summary: 'running', isError: false }

    expect(named('browser_open').presentResult?.({ url: 'https://example.com/' }, running)).toEqual(
      {
        summary: 'opened https://example.com/',
        isError: false,
      },
    )
    expect(named('browser_snapshot').presentResult?.({}, running)).toEqual({
      summary: 'read the page',
      isError: false,
    })
    expect(named('browser_click').presentResult?.({ selector: '#go' }, running)).toEqual({
      summary: 'clicked #go',
      isError: false,
    })
    expect(named('browser_type').presentResult?.({ selector: '#q', text: 'x' }, running)).toEqual({
      summary: 'typed into #q',
      isError: false,
    })
  })
})
