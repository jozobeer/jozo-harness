import type { SessionEvent } from '@jozo-harness/session'
import { parseWorkerOutgoing, type WorkerIncoming } from './worker-protocol.ts'

/** The part of a Worker the page uses; tests substitute their own. */
export interface WorkerLike {
  readonly postMessage: (message: WorkerIncoming) => void
  readonly addEventListener: (
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ) => void
  readonly removeEventListener: (
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ) => void
  readonly terminate: () => void
}

export interface BrowserWorkerClientOptions {
  /** How the page makes its worker: `new Worker(url, { type: 'module' })` or a fake. */
  readonly createWorker: () => WorkerLike
  /** Called with every event the turn wrote, before the prompt resolves. */
  readonly onEvent: (event: SessionEvent) => void
}

/** The page's end of the worker protocol: one prompt at a time. */
export interface BrowserWorkerClient {
  /** Sends one turn and resolves with the assistant's answer. */
  readonly prompt: (text: string) => Promise<string>
  /** Stops the worker, and with it the workspace and the log. */
  readonly close: () => void
}

/**
 * Talks to the browser runtime through a worker. The worker is injected because
 * a page has exactly one way to make a real one and a test has none.
 */
export const createBrowserWorkerClient = (
  options: BrowserWorkerClientOptions,
): BrowserWorkerClient => {
  const worker = options.createWorker()
  let pending:
    | { readonly resolve: (text: string) => void; readonly reject: (error: Error) => void }
    | undefined
  let closed = false

  const onMessage = (message: { readonly data: unknown }): void => {
    const parsed = parseWorkerOutgoing(message.data)
    if (parsed === undefined) return
    if (parsed.kind === 'event') {
      options.onEvent(parsed.event)
      return
    }
    const turn = pending
    if (turn === undefined) return
    pending = undefined
    if (parsed.kind === 'done') turn.resolve(parsed.text)
    else turn.reject(new Error(parsed.message))
  }

  worker.addEventListener('message', onMessage)

  return {
    prompt: (text: string): Promise<string> => {
      if (closed) return Promise.reject(new Error('the browser worker is closed'))
      if (pending !== undefined) {
        return Promise.reject(new Error('a turn is already running'))
      }
      return new Promise<string>((resolve, reject) => {
        pending = { resolve, reject }
        worker.postMessage({ kind: 'prompt', text })
      })
    },
    close: (): void => {
      if (closed) return
      closed = true
      worker.removeEventListener('message', onMessage)
      worker.terminate()
      const turn = pending
      pending = undefined
      turn?.reject(new Error('the browser worker was closed'))
    },
  }
}
