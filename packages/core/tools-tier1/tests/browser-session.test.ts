import { Effect, Exit, Scope } from 'effect'
import { describe, expect, test } from 'vitest'
import type { ToolError } from '@jozo-harness/tools'
import {
  browserSessionTools,
  makeBrowserSession,
  sessionBrowserCommand,
  type BrowserSessionHost,
  type BrowserSession,
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
      if (expression.includes('document.querySelectorAll')) {
        return Promise.resolve({ result: { type: 'string', value: JSON.stringify(page) } })
      }
      return Promise.resolve({
        result: {
          type: 'string',
          value: JSON.stringify(
            options.found === false ? { found: false } : { found: true, tag: 'button' },
          ),
        },
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
const openSession = async (host: BrowserSessionHost): Promise<Opened> => {
  const scope = await Effect.runPromise(Scope.make())
  const session = await Effect.runPromise(
    makeBrowserSession(host, {
      startupMs: 1_000,
      navigationMs: 1_000,
      cdpMs: 100,
      pollMs: 1,
    }).pipe(Effect.provideService(Scope.Scope, scope)),
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
