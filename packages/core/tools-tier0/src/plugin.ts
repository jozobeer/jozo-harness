import { PluginError, type Plugin } from '@jozo-harness/kernel'
import { Sandbox, type ApprovalShape } from '@jozo-harness/safety'
import { Context, Effect, Layer, Schema } from 'effect'
import type { ToolDefinition } from '@jozo-harness/tools'
import { BASH_MAX_TIMEOUT_MS, type TimeoutJobs } from './bash.ts'
import { managedEnv } from './managed-env.ts'
import type { ShellSessions } from './shells.ts'
import type { WorktreeHost } from './worktree.ts'
import { tier0Tools } from './index.ts'

/**
 * Builds the Tier 0 tool list: the profile's sandbox, and the approval seam of
 * this run. The seam is the caller's, not the profile's — a deployment that
 * composes no answerer passes nothing and every escalation is refused.
 */
export type Tier0ToolBuilder = (
  approval: ApprovalShape | undefined,
  jobs?: TimeoutJobs,
  worktree?: WorktreeHost,
  /** The shells a named bash session keeps; the run closes them when it ends. */
  sessions?: ShellSessions,
  /** The wait a bash call gets when it names none; overrides the row's timeoutMs. */
  defaultTimeoutMs?: () => number | undefined,
) => ReadonlyArray<ToolDefinition<any, any>>

/** The Tier 0 tool list, ready for whoever registers tools into the registry. */
export class Tier0Tools extends Context.Service<Tier0Tools, Tier0ToolBuilder>()(
  'jozo-harness/Tier0Tools',
) {}

/** The harness-owned variables a profile registers for every command. */
const tier0ConfigSchema = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The wait a bash call gets when it names none, in milliseconds. Defaults to 120000. */
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BASH_MAX_TIMEOUT_MS })),
  ),
})

/** Loader definition for the Tier 0 tools; bash uses the profile's sandbox and env. */
export const tier0Plugin: Plugin<
  Schema.Schema.Type<typeof tier0ConfigSchema>,
  Tier0Tools,
  Sandbox
> = {
  name: '@jozo-harness/tools-tier0',
  config: tier0ConfigSchema,
  provides: [Tier0Tools],
  requires: [Sandbox],
  layer: (config) =>
    Layer.effect(
      Tier0Tools,
      Effect.gen(function* () {
        const sandbox = yield* Sandbox
        const managed = yield* Effect.try({
          try: () => managedEnv(config.env ?? {}),
          catch: (error) =>
            new PluginError({
              code: 'config',
              message: error instanceof Error ? error.message : String(error),
            }),
        })
        return (approval, jobs, worktree, sessions, defaultTimeoutMs) =>
          tier0Tools(
            sandbox,
            undefined,
            approval,
            jobs,
            worktree,
            sessions,
            managed,
            defaultTimeoutMs ?? (() => config.timeoutMs),
          )
      }),
    ),
}
