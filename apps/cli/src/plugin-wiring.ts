import { Effect } from 'effect'
import { ToolError } from '@jozo-harness/tools'

/** A row whose wiring failed: what to name on the page, and what the failure said. */
export interface PluginWiringFailure {
  readonly id: string
  readonly name: string
  readonly reason: string
}

/** One failed row, with the attempt that can be made again. */
interface FailedRow {
  readonly name: string
  readonly reason: string
  readonly retry: () => Effect.Effect<void, ToolError>
}

/**
 * The rows this run could not wire, kept for the page that reports them.
 *
 * A session records a row here instead of failing its build, and the retry runs
 * the same wiring over the same running services. Nothing here rebuilds the
 * Layer the run was built from; a retry only registers the row's tools again.
 */
export interface PluginWiringState {
  readonly failures: () => ReadonlyArray<PluginWiringFailure>
  /** Keeps the row and the wiring to try again when a session could not wire it. */
  readonly record: (
    id: string,
    name: string,
    reason: string,
    retry: () => Effect.Effect<void, ToolError>,
  ) => void
  /** Drops the row once its wiring succeeds. */
  readonly clear: (id: string) => void
  /** Wires the row again; fails only when no failed row has that id. */
  readonly retry: (id: string) => Effect.Effect<void, ToolError>
}

/** A run-level list: the same row failing in two sessions reads as one row. */
export const makePluginWiringState = (): PluginWiringState => {
  const failed = new Map<string, FailedRow>()
  return {
    failures: () => [...failed].map(([id, row]) => ({ id, name: row.name, reason: row.reason })),
    record: (id, name, reason, retry) => {
      failed.set(id, { name, reason, retry })
    },
    clear: (id) => {
      failed.delete(id)
    },
    retry: (id) =>
      Effect.gen(function* () {
        const row = failed.get(id)
        if (row === undefined) {
          return yield* Effect.fail(
            new ToolError({
              code: 'invalid-arguments',
              message: 'no plugin row failed with that id: ' + id,
            }),
          )
        }
        yield* row.retry()
      }),
  }
}
