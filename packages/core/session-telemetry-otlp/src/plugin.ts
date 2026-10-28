import { Hooks, type Plugin } from '@jozo-harness/kernel'
import { Context, Effect, Layer, type Scope } from 'effect'
import { resolveTelemetry, telemetryConfigSchema, type TelemetryConfig } from './config.ts'
import { createTelemetryExporter } from './exporter.ts'
import { anonymousUserIdentity, type AnonymousIdentity } from './identity.ts'

/** How often a waiting batch is sent; a closed scope flushes whatever is left. */
export const FLUSH_INTERVAL_MS = 2000

export interface SessionTelemetryHandle {
  readonly enabled: boolean
  readonly flush: Effect.Effect<void>
}

/** The plugin's service: a test or a host can flush a batch without waiting for the clock. */
export class SessionTelemetry extends Context.Service<SessionTelemetry, SessionTelemetryHandle>()(
  'jozo-harness/SessionTelemetry',
) {}

const DISABLED: SessionTelemetryHandle = { enabled: false, flush: Effect.void }

const keepIdentity = (path: string): Effect.Effect<AnonymousIdentity | undefined> =>
  anonymousUserIdentity({ path }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning('telemetry stays off: the anonymous id could not be kept', {
        path,
        reason: cause.message,
      }).pipe(Effect.as(undefined)),
    ),
  )

/**
 * Builds the exporter only when a human named both an endpoint and a scope. No
 * endpoint and no scope means no listener, no id read, and no request.
 */
export const makeSessionTelemetry = (
  config: TelemetryConfig,
): Effect.Effect<SessionTelemetryHandle, never, Hooks | Scope.Scope> =>
  Effect.gen(function* () {
    const resolved = resolveTelemetry(config)
    if (resolved.endpoint === '' || resolved.scope === 'off') return DISABLED
    const identity = yield* keepIdentity(resolved.identityPath)
    if (identity === undefined) return DISABLED
    const hooks = yield* Hooks
    const exporter = createTelemetryExporter({
      endpoint: resolved.endpoint,
      scope: resolved.scope,
      anonymousId: identity.id,
      headers: resolved.headers,
    })
    yield* hooks.on('session/event', (event, session) => {
      exporter.enqueue(session.id, event)
    })
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(FLUSH_INTERVAL_MS).pipe(Effect.andThen(exporter.flush()))),
    )
    yield* Effect.addFinalizer(() => exporter.flush())
    return { enabled: true, flush: exporter.flush() }
  })

/** Loader definition for the opt-in OTLP session log exporter. */
export const sessionTelemetryPlugin: Plugin<TelemetryConfig, SessionTelemetry, Hooks> = {
  name: '@jozo-harness/session-telemetry-otlp',
  config: telemetryConfigSchema,
  provides: [SessionTelemetry],
  requires: [Hooks],
  layer: (config) => Layer.effect(SessionTelemetry, makeSessionTelemetry(config)),
}
