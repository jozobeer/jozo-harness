import type { SessionEvent } from '@jozo-harness/session'

/** What a page asks the worker to do. One message is one turn. */
export interface WorkerPrompt {
  readonly kind: 'prompt'
  readonly text: string
}

/** One log event, in the order the session wrote it. */
export interface WorkerEvent {
  readonly kind: 'event'
  readonly event: SessionEvent
}

/** The turn ended; `text` is the assistant's last message. */
export interface WorkerDone {
  readonly kind: 'done'
  readonly text: string
}

/** The turn failed; the page may show the message and prompt again. */
export interface WorkerError {
  readonly kind: 'error'
  readonly message: string
}

/** What the page may send. */
export type WorkerIncoming = WorkerPrompt

/** What the worker may send. */
export type WorkerOutgoing = WorkerEvent | WorkerDone | WorkerError

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Reads a message from the page. A worker receives whatever the page posted, so
 * the shape is decided here rather than trusted at every use.
 */
export const parseWorkerIncoming = (data: unknown): WorkerPrompt | undefined => {
  if (!isRecord(data) || data['kind'] !== 'prompt' || typeof data['text'] !== 'string') {
    return undefined
  }
  return { kind: 'prompt', text: data['text'] }
}

/** Reads a message from the worker, dropping anything that is not this protocol. */
export const parseWorkerOutgoing = (data: unknown): WorkerOutgoing | undefined => {
  if (!isRecord(data)) return undefined
  if (data['kind'] === 'done' && typeof data['text'] === 'string') {
    return { kind: 'done', text: data['text'] }
  }
  if (data['kind'] === 'error' && typeof data['message'] === 'string') {
    return { kind: 'error', message: data['message'] }
  }
  if (
    data['kind'] === 'event' &&
    isRecord(data['event']) &&
    typeof data['event']['type'] === 'string'
  ) {
    return { kind: 'event', event: data['event'] as unknown as SessionEvent }
  }
  return undefined
}
