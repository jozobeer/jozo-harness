import type { Plugin } from '@jozo-harness/kernel'
import { Schema } from 'effect'
import { SystemPrompt, systemPromptLayerWith } from './system-prompt.ts'

export const systemPromptConfigSchema = Schema.Struct({
  /** Introduces the harness in the prompt; turn it off to supply your own opener. */
  includeHarnessIdentity: Schema.optionalKey(Schema.Boolean),
  /** Tool usage lines, shown only for the tools the model can call. */
  includeToolGuidance: Schema.optionalKey(Schema.Boolean),
  /** Deployment prose around the identity; a blank part renders no section. */
  persona: Schema.optionalKey(
    Schema.Struct({
      before: Schema.optionalKey(Schema.String),
      after: Schema.optionalKey(Schema.String),
    }),
  ),
})

export type SystemPromptConfig = Schema.Schema.Type<typeof systemPromptConfigSchema>

/** Loader definition for the prompt section registry. */
export const systemPromptPlugin: Plugin<SystemPromptConfig, SystemPrompt, never> = {
  name: '@jozo-harness/system-prompt',
  config: systemPromptConfigSchema,
  provides: [SystemPrompt],
  requires: [],
  layer: (config) => systemPromptLayerWith(config),
}
