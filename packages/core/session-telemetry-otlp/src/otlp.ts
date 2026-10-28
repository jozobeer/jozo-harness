import type { SessionEvent } from '@jozo-harness/session'
import type { TelemetryScope } from './config.ts'

/** One session event, tagged with the session it belongs to. */
export interface TelemetryRecord {
  readonly sessionId: string
  readonly event: SessionEvent
}

/** A record body larger than this is cut; a single tool result must not fill the batch. */
export const RECORD_BODY_LIMIT = 20000

/** The filter that makes `feedback` a small scope rather than an alias for `all`. */
export const scopeSelects = (scope: TelemetryScope, event: SessionEvent): boolean => {
  if (scope === 'off') return false
  if (scope === 'feedback') return event.type === 'feedback/rated'
  return true
}

interface Attribute {
  readonly key: string
  readonly value: { readonly stringValue: string } | { readonly intValue: string }
}

const stringAttribute = (key: string, value: string): Attribute => ({
  key,
  value: { stringValue: value },
})

const intAttribute = (key: string, value: number): Attribute => ({
  key,
  value: { intValue: String(value) },
})

const nanos = (milliseconds: number): string =>
  String(BigInt(Math.trunc(milliseconds)) * 1_000_000n)

const bodyOf = (event: SessionEvent): string => {
  const text = JSON.stringify(event.data) ?? ''
  return text.length > RECORD_BODY_LIMIT ? text.slice(0, RECORD_BODY_LIMIT) + '…(truncated)' : text
}

const logRecordOf = (record: TelemetryRecord, observedAt: number) => ({
  timeUnixNano: nanos(record.event.time),
  observedTimeUnixNano: nanos(observedAt),
  severityNumber: 9,
  severityText: 'INFO',
  body: { stringValue: bodyOf(record.event) },
  attributes: [
    stringAttribute('session.id', record.sessionId),
    stringAttribute('session.event.type', record.event.type),
    intAttribute('session.event.seq', record.event.seq),
  ],
})

export interface OtlpLogsOptions {
  readonly anonymousId: string
  /** The send time, kept apart from the event time so a late batch is not mistaken for a late event. */
  readonly observedAt: number
  readonly records: ReadonlyArray<TelemetryRecord>
}

/**
 * The OTLP/HTTP JSON body for one batch. The anonymous id rides the resource, not
 * the body, so log text and dumps never carry it.
 */
export const otlpLogsPayload = (options: OtlpLogsOptions) => ({
  resourceLogs: [
    {
      resource: {
        attributes: [
          stringAttribute('service.name', 'jozo-harness'),
          stringAttribute('anonymous.user.id', options.anonymousId),
        ],
      },
      scopeLogs: [
        {
          scope: { name: '@jozo-harness/session-telemetry-otlp' },
          logRecords: options.records.map((record) => logRecordOf(record, options.observedAt)),
        },
      ],
    },
  ],
})
