export {
  defaultIdentityPath,
  logsUrl,
  resolveTelemetry,
  TELEMETRY_SCOPES,
  telemetryConfigSchema,
  type ResolvedTelemetry,
  type TelemetryConfig,
  type TelemetryScope,
} from './config.ts'
export {
  createTelemetryExporter,
  DEFAULT_MAX_BATCH_EVENTS,
  DEFAULT_MAX_BUFFERED_EVENTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type TelemetryExporter,
  type TelemetryExporterOptions,
  type TelemetryFailure,
} from './exporter.ts'
export { anonymousUserIdentity, type AnonymousIdentity } from './identity.ts'
export {
  otlpLogsPayload,
  RECORD_BODY_LIMIT,
  scopeSelects,
  type OtlpLogsOptions,
  type TelemetryRecord,
} from './otlp.ts'
export {
  FLUSH_INTERVAL_MS,
  makeSessionTelemetry,
  SessionTelemetry,
  sessionTelemetryPlugin,
  type SessionTelemetryHandle,
} from './plugin.ts'
