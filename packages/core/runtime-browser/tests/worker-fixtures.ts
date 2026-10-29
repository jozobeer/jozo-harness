import type { LlmTransport } from '@jozo-harness/llm'
import type { SessionEvent } from '@jozo-harness/session'
import { parseWorkerIncoming } from '../src/worker-protocol.ts'
import { createBrowserWorkerClient, type WorkerLike } from '../src/worker-client.ts'
import { createBrowserWorkerHost } from '../src/worker-host.ts'

const sse = (events: ReadonlyArray<readonly [string, unknown]>): string =>
  events.map(([name, body]) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`).join('')

const response = (events: ReadonlyArray<readonly [string, unknown]>): Response =>
  new Response(sse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

export const toolCallTurn = (name: string, argumentsJson: string) =>
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

export const textTurn = (text: string) =>
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

/** A transport that answers in the order a test wrote the turns. */
export const stubTransport = (turns: ReadonlyArray<Response>): LlmTransport => {
  let sent = 0
  return async () => {
    const next = turns[sent]
    sent += 1
    if (next === undefined)
      throw new Error('the turn asked for more model calls than the stub wrote')
    return next
  }
}

/**
 * A Worker whose thread is the test process: the real host runs, and the test
 * only supplies the message plumbing a browser would.
 */
export const fakeWorker = (transport: LlmTransport) => {
  const listeners = new Set<(event: { readonly data: unknown }) => void>()
  const host = createBrowserWorkerHost({
    route: 'stub/model',
    baseUrl: 'https://model.test/anthropic',
    apiKey: () => 'test-key',
    transport,
    post: (message) => {
      for (const listener of listeners) listener({ data: message })
    },
  })
  let closing: Promise<void> = Promise.resolve()
  const worker: WorkerLike = {
    postMessage: (message) => {
      const prompt = parseWorkerIncoming(message)
      if (prompt !== undefined) void host.prompt(prompt.text)
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener)
    },
    terminate: () => {
      closing = host.close()
    },
  }
  return { worker, whenClosed: () => closing }
}

/** The text blocks of a `tool/result`, which is what the page would show. */
export const resultText = (event: SessionEvent): string =>
  event.type === 'tool/result'
    ? event.data.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    : ''

export const clientOf = (transport: LlmTransport) => {
  const events: SessionEvent[] = []
  const fake = fakeWorker(transport)
  const client = createBrowserWorkerClient({
    createWorker: () => fake.worker,
    onEvent: (event) => events.push(event),
  })
  return { client, events, whenClosed: fake.whenClosed }
}
