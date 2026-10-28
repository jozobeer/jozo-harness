import type { Plugin } from '@jozo-harness/kernel'
import { Ask } from '@jozo-harness/safety'
import { Context, Effect, Layer, Schema } from 'effect'
import type { ToolDefinition } from '@jozo-harness/tools'
import { tier1Tools } from './index.ts'

/** The Tier 1 tool list, ready for whoever registers tools into the registry. */
export class Tier1Tools extends Context.Service<
  Tier1Tools,
  ReadonlyArray<ToolDefinition<any, any>>
>()('jozo-harness/Tier1Tools') {}

/** The ask tool's default wait for a batch; absent leaves the tool waiting until answered. */
const tier1ConfigSchema = Schema.Struct({
  timeLimitMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

/** Loader definition for the Tier 1 tools; the ask tool uses the ask holder. */
export const tier1Plugin: Plugin<Schema.Schema.Type<typeof tier1ConfigSchema>, Tier1Tools, Ask> = {
  name: '@jozo-harness/tools-tier1',
  config: tier1ConfigSchema,
  provides: [Tier1Tools],
  requires: [Ask],
  layer: (config) =>
    Layer.effect(
      Tier1Tools,
      Effect.map(Ask, (ask) => tier1Tools(ask, [], undefined, config.timeLimitMs)),
    ),
}
