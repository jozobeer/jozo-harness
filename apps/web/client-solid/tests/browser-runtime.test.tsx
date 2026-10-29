import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import type { SessionEvent } from '@jozo-harness/session'
import { startBrowserWorker, type BrowserWorkerScope } from '@jozo-harness/runtime-browser/worker'
import {
  createBrowserWorkerClient,
  type WorkerLike,
} from '@jozo-harness/runtime-browser/worker-client'
import {
  API_KEY_STORAGE_KEY,
  DEFAULT_BASE_URL,
  DEFAULT_ROUTE,
  browserWorkerInitFrom,
  parseBrowserWorkerInit,
} from '../runtime/init.ts'
import { runtimeModeFrom } from '../runtime/mode.ts'
import { BrowserRuntimePage, pageWorker } from '../runtime/page.tsx'

const sse = (events: ReadonlyArray<readonly [string, unknown]>): string =>
  events.map(([name, body]) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`).join('')

const response = (events: ReadonlyArray<readonly [string, unknown]>): Response =>
  new Response(sse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

const toolCallTurn = (name: string, argumentsJson: string) =>
  response([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10 } } }],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: argumentsJson },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])

const textTurn = (text: string) =>
  response([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10 } } }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])

const stubTransport = (turns: ReadonlyArray<Response>) => {
  let sent = 0
  return async () => {
    const next = turns[sent]
    sent += 1
    if (next === undefined) {
      throw new Error('the turn asked for more model calls than the stub wrote')
    }
    return next
  }
}

/**
 * A Worker whose thread is this process. The real worker entry runs on a fake
 * scope, so a test sees the same protocol the browser would and can prove what
 * the page shows, while terminate really closes the runtime.
 */
const fakeWorker = (transport: ReturnType<typeof stubTransport>) => {
  const scopeListeners = new Set<(event: { readonly data: unknown }) => void>()
  const pageListeners = new Set<(event: { readonly data: unknown }) => void>()
  const events: SessionEvent[] = []
  let closing: Promise<void> = Promise.resolve()
  const scope: BrowserWorkerScope = {
    postMessage: (message) => {
      for (const listener of pageListeners) listener({ data: message })
    },
    addEventListener: (_type, listener) => {
      scopeListeners.add(listener)
    },
  }
  const host = startBrowserWorker(scope, {
    route: 'stub/model',
    baseUrl: 'https://model.test/anthropic',
    apiKey: () => 'test-key',
    transport,
  })
  const worker: WorkerLike = {
    postMessage: (message) => {
      for (const listener of scopeListeners) listener({ data: message })
    },
    addEventListener: (_type, listener) => {
      pageListeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      pageListeners.delete(listener)
    },
    terminate: () => {
      closing = host.close()
    },
  }
  return { worker, events, whenClosed: () => closing }
}

const openWith = (worker: WorkerLike, events: SessionEvent[]) => {
  return (onEvent: (event: SessionEvent) => void) =>
    createBrowserWorkerClient({
      createWorker: () => worker,
      onEvent: (event) => {
        events.push(event)
        onEvent(event)
      },
    })
}

const prompt = (text: string): void => {
  fireEvent.input(screen.getByLabelText('Prompt'), { target: { value: text } })
  fireEvent.submit(screen.getByTestId('prompt-form'))
}

afterEach(cleanup)

describe('the page that runs the harness in a worker', () => {
  test('shows the answer and the tool call, then drops the workspace with the worker', async () => {
    const first = fakeWorker(
      stubTransport([
        toolCallTurn('write', JSON.stringify({ path: 'note.txt', content: 'kept in memory\n' })),
        textTurn('Wrote note.txt.'),
      ]),
    )
    const firstEvents: SessionEvent[] = []
    const firstRender = render(() => (
      <BrowserRuntimePage open={openWith(first.worker, firstEvents)} />
    ))

    prompt('write a note')
    expect(await screen.findByTestId('answer')).toHaveProperty('textContent', 'Wrote note.txt.')
    expect(screen.getByTestId('tool-call').textContent).toContain('write')
    expect(
      firstEvents.some((event) => event.type === 'tool/result' && event.data.isError === false),
    ).toBe(true)

    firstRender.unmount()
    await first.whenClosed()

    // A second worker has a new memory workspace: the note written above is gone.
    const second = fakeWorker(
      stubTransport([
        toolCallTurn('read', JSON.stringify({ path: 'note.txt' })),
        textTurn('The note is gone.'),
      ]),
    )
    const secondEvents: SessionEvent[] = []
    const secondRender = render(() => (
      <BrowserRuntimePage open={openWith(second.worker, secondEvents)} />
    ))

    prompt('read the note')
    expect(await screen.findByTestId('answer')).toHaveProperty('textContent', 'The note is gone.')
    const read = secondEvents.find((event) => event.type === 'tool/result')
    expect(read?.type === 'tool/result' ? read.data.isError : false).toBe(true)

    secondRender.unmount()
    await second.whenClosed()
  })
})

describe('the browser runtime entry', () => {
  test('opts in with ?runtime=browser and leaves the server page as the default', () => {
    expect(runtimeModeFrom('?runtime=browser')).toBe('browser')
    expect(runtimeModeFrom('?session=s-1&runtime=browser')).toBe('browser')
    expect(runtimeModeFrom('')).toBe('server')
    expect(runtimeModeFrom('?runtime=node')).toBe('server')
  })

  test('takes the model settings from the page and the key from session storage', () => {
    const storage = { getItem: (key: string) => (key === API_KEY_STORAGE_KEY ? 'secret' : null) }

    expect(browserWorkerInitFrom('?route=stub/model&baseUrl=https://model.test', storage)).toEqual({
      kind: 'init',
      route: 'stub/model',
      baseUrl: 'https://model.test',
      apiKey: 'secret',
    })
    expect(browserWorkerInitFrom('', storage)).toEqual({
      kind: 'init',
      route: DEFAULT_ROUTE,
      baseUrl: DEFAULT_BASE_URL,
      apiKey: 'secret',
    })
    expect(parseBrowserWorkerInit({ kind: 'init', route: 'r', baseUrl: 'b', apiKey: 'k' })).toEqual(
      {
        kind: 'init',
        route: 'r',
        baseUrl: 'b',
        apiKey: 'k',
      },
    )
    expect(parseBrowserWorkerInit({ kind: 'prompt', text: 'hi' })).toBeUndefined()
    expect(parseBrowserWorkerInit({ kind: 'init', route: 1 })).toBeUndefined()
  })

  test('creates a module worker and posts the settings before any prompt', () => {
    const made: Array<{ url: URL; options: WorkerOptions; messages: unknown[] }> = []
    class StubWorker {
      readonly messages: unknown[] = []
      constructor(
        readonly url: URL,
        readonly options: WorkerOptions,
      ) {
        made.push(this)
      }
      postMessage(message: unknown): void {
        this.messages.push(message)
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      terminate(): void {}
    }
    vi.stubGlobal('Worker', StubWorker)
    const init = browserWorkerInitFrom('?route=stub/model', {
      getItem: () => null,
    })

    const worker = pageWorker(init)

    expect(worker).toBeInstanceOf(StubWorker)
    expect(made).toHaveLength(1)
    expect(String(made[0]?.url)).toContain('worker-entry')
    expect(made[0]?.options).toMatchObject({ type: 'module' })
    expect(made[0]?.messages).toEqual([init])
    vi.unstubAllGlobals()
  })
})
