import { homedir } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'

/** What a session log carries to a collector. Off unless a human asks for a scope. */
export const TELEMETRY_SCOPES = ['off', 'feedback', 'all'] as const

export type TelemetryScope = (typeof TELEMETRY_SCOPES)[number]

export const telemetryConfigSchema = Schema.Struct({
  /** The OTLP/HTTP base; the exporter posts to `<endpoint>/v1/logs`. */
  endpoint: Schema.optionalKey(Schema.String),
  /** Which session events to send. The default sends nothing. */
  scope: Schema.optionalKey(Schema.Literals(TELEMETRY_SCOPES)),
  /** Extra request headers, e.g. a collector token. */
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Where the anonymous id lives. Kept out of the log body and dumps. */
  identityPath: Schema.optionalKey(Schema.String),
})

export type TelemetryConfig = Schema.Schema.Type<typeof telemetryConfigSchema>

export interface ResolvedTelemetry {
  readonly endpoint: string
  readonly scope: TelemetryScope
  readonly headers: Readonly<Record<string, string>>
  readonly identityPath: string
}

/** One id per home, not one per send. Deleting the file starts a new identity. */
export const defaultIdentityPath = (): string => join(homedir(), '.jzh', 'anonymous-user-id')

/** An unset endpoint and an unset scope both mean "send nothing". */
export const resolveTelemetry = (config: TelemetryConfig): ResolvedTelemetry => ({
  endpoint: (config.endpoint ?? '').trim(),
  scope: config.scope ?? 'off',
  headers: config.headers ?? {},
  identityPath: config.identityPath ?? defaultIdentityPath(),
})

/** The endpoint accepts either the base or the full logs path. */
export const logsUrl = (endpoint: string): string => {
  const base = endpoint.replace(/\/+$/, '')
  return base.endsWith('/v1/logs') ? base : base + '/v1/logs'
}
