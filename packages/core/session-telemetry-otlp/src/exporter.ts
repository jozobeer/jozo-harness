import type { SessionEvent } from '@jozo-harness/session'
import { Effect } from 'effect'
import { logsUrl, type TelemetryScope } from './config.ts'
import { otlpLogsPayload, scopeSelects, type TelemetryRecord } from './otlp.ts'

/** Small batches keep one slow collector from holding the whole session log. */
export const DEFAULT_MAX_BATCH_EVENTS = 20

/** Past this many waiting events, the oldest are dropped rather than sent late. */
export const DEFAULT_MAX_BUFFERED_EVENTS = 200

export const DEFAULT_REQUEST_TIMEOUT_MS = 5000

/** Why one batch did not reach the collector. The reason never carries event text. */
export interface TelemetryFailure {
  readonly endpoint: string
  readonly recordCount: number
  readonly reason: string
}

export interface TelemetryExporterOptions {
  readonly endpoint: string
  readonly scope: TelemetryScope
  /** Read once per batch, so deleting the id file starts a new identity on the next send. */
  readonly identity: () => Effect.Effect<string, Error>
  readonly headers?: Readonly<Record<string, string>>
  /** Replaced by tests; the plugin uses the process fetch. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly maxBatchEvents?: number
  readonly maxBufferedEvents?: number
  readonly timeoutMs?: number
  /** Where a failed delivery goes; the default is a warning, never a throw. */
  readonly report?: (failure: TelemetryFailure) => Effect.Effect<void>
}

export interface TelemetryExporter {
  /** Never performs I/O and never fails, so a session's notify path is unaffected. */
  readonly enqueue: (sessionId: string, event: SessionEvent) => void
  /** Sends what is waiting, in bounded batches. A failed batch is reported and dropped. */
  readonly flush: () => Effect.Effect<void>
  readonly pending: () => number
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export const createTelemetryExporter = (options: TelemetryExporterOptions): TelemetryExporter => {
  const queue: Array<TelemetryRecord> = []
  let dropped = 0
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const batchSize = Math.max(1, options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS)
  const bufferLimit = Math.max(batchSize, options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS)
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const url = logsUrl(options.endpoint)
  const report =
    options.report ??
    ((failure: TelemetryFailure) =>
      Effect.logWarning('telemetry: a session log batch was not delivered', failure))

  const post = async (
    records: ReadonlyArray<TelemetryRecord>,
    anonymousId: string,
  ): Promise<void> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...options.headers, 'content-type': 'application/json' },
      body: JSON.stringify(otlpLogsPayload({ anonymousId, observedAt: now(), records })),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error('collector answered HTTP ' + String(response.status))
  }

  const deliver = (records: ReadonlyArray<TelemetryRecord>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const anonymousId = yield* options.identity()
      yield* Effect.tryPromise({
        try: () => post(records, anonymousId),
        catch: (cause) => cause,
      })
    }).pipe(
      Effect.catch((cause) =>
        report({ endpoint: url, recordCount: records.length, reason: describe(cause) }),
      ),
      // A reporting failure must not become a session failure either.
      Effect.catchCause(() => Effect.void),
    )

  const flush = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (dropped > 0) {
        const count = dropped
        dropped = 0
        yield* Effect.logWarning('telemetry: the send buffer dropped old session events', {
          dropped: count,
        })
      }
      while (queue.length > 0) {
        yield* deliver(queue.splice(0, batchSize))
      }
    })

  const enqueue = (sessionId: string, event: SessionEvent): void => {
    if (!scopeSelects(options.scope, event)) return
    queue.push({ sessionId, event })
    while (queue.length > bufferLimit) {
      queue.shift()
      dropped += 1
    }
  }

  return { enqueue, flush, pending: () => queue.length }
}
