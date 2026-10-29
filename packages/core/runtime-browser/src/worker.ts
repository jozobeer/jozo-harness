import type { LlmTransport } from '@jozo-harness/llm'
import {
  createBrowserWorkerHost,
  type BrowserWorkerHost,
  type BrowserWorkerHostOptions,
} from './worker-host.ts'
import { parseWorkerIncoming, type WorkerOutgoing } from './worker-protocol.ts'

/** The part of a DedicatedWorkerGlobalScope the entry uses. */
export interface BrowserWorkerScope {
  readonly postMessage: (message: WorkerOutgoing) => void
  readonly addEventListener: (
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ) => void
}

/** What a page hands its worker; the transport defaults to the page's own fetch. */
export type BrowserWorkerConfig = Omit<BrowserWorkerHostOptions, 'post' | 'transport'> & {
  readonly transport?: LlmTransport
}

/**
 * Starts the runtime behind a worker's message port. The bundler entry calls
 * this with the worker's own scope and the page's model settings; a test calls
 * it with a fake scope, which is why the scope is a parameter rather than self.
 */
export const startBrowserWorker = (
  scope: BrowserWorkerScope,
  config: BrowserWorkerConfig,
): BrowserWorkerHost => {
  const host = createBrowserWorkerHost({
    ...config,
    transport: config.transport ?? ((input, init) => fetch(input, init)),
    post: (message) => scope.postMessage(message),
  })
  scope.addEventListener('message', (event) => {
    const prompt = parseWorkerIncoming(event.data)
    if (prompt !== undefined) void host.prompt(prompt.text)
  })
  return host
}
