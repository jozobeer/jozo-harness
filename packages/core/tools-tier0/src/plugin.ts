import type { Plugin } from '@jozo-harness/kernel'
import { Sandbox, type ApprovalShape } from '@jozo-harness/safety'
import { Context, Effect, Layer, Schema } from 'effect'
import type { ToolDefinition } from '@jozo-harness/tools'
import type { TimeoutJobs } from './bash.ts'
import { tier0Tools } from './index.ts'

/**
 * Builds the Tier 0 tool list: the profile's sandbox, and the approval seam of
 * this run. The seam is the caller's, not the profile's — a deployment that
 * composes no answerer passes nothing and every escalation is refused.
 */
export type Tier0ToolBuilder = (
  approval: ApprovalShape | undefined,
  jobs?: TimeoutJobs,
) => ReadonlyArray<ToolDefinition<any, any>>

/** The Tier 0 tool list, ready for whoever registers tools into the registry. */
export class Tier0Tools extends Context.Service<Tier0Tools, Tier0ToolBuilder>()(
  'jozo-harness/Tier0Tools',
) {}

/** Loader definition for the Tier 0 tools; bash uses the profile's sandbox. */
export const tier0Plugin: Plugin<{}, Tier0Tools, Sandbox> = {
  name: '@jozo-harness/tools-tier0',
  config: Schema.Struct({}),
  provides: [Tier0Tools],
  requires: [Sandbox],
  layer: () =>
    Layer.effect(
      Tier0Tools,
      Effect.map(
        Sandbox,
        (sandbox) => (approval, jobs) => tier0Tools(sandbox, undefined, approval, jobs),
      ),
    ),
}
