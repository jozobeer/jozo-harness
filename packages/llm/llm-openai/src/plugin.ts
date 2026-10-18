import { Llm } from '@jozo-harness/llm'
import type { Plugin } from '@jozo-harness/kernel'
import { Layer, Schema } from 'effect'
import { openAiAdapter } from './adapter.ts'

/** Settings of the OpenAI-compatible provider. */
export const llmOpenAiConfig = Schema.Struct({
  baseUrl: Schema.String,
  /** Name of the environment variable that holds the key. */
  apiKeyEnv: Schema.String,
  /** Idle budget for one provider attempt, in milliseconds. */
  streamIdleTimeoutMs: Schema.optionalKey(Schema.Int),
  /** The routed model's context window in tokens, for compaction pressure. */
  contextWindow: Schema.optionalKey(Schema.Int),
  /**
   * The effort words this endpoint takes, as a UI offers them. The row decides,
   * because the same field means different words to different deployments; an
   * empty list declares none, so no control is offered.
   */
  reasoningEfforts: Schema.optionalKey(Schema.Array(Schema.String)),
})

/**
 * The words the OpenAI-compatible `reasoning_effort` field takes when a row
 * names none: the escalation providers advertise, without the levels that mean
 * "no thinking" (a run that names none leaves that to the provider).
 */
const WIRE_EFFORTS: ReadonlyArray<string> = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Loader definition for the Ollama Cloud adapter. The capability set is the
 * one the recording confirmed: no `tool_choice`, no prompt cache control, and
 * the effort words the row (or the wire's own) declares.
 */
export const llmOpenAiPlugin: Plugin<typeof llmOpenAiConfig.Type, Llm, never> = {
  name: '@jozo-harness/llm-openai',
  config: llmOpenAiConfig,
  provides: [Llm],
  requires: [],
  layer: (config) =>
    Layer.succeed(
      Llm,
      openAiAdapter({
        baseUrl: config.baseUrl,
        apiKey: () => process.env[config.apiKeyEnv],
        capabilities: {
          toolChoice: false,
          reasoningEffort: config.reasoningEfforts ?? WIRE_EFFORTS,
          images: 'none',
          promptCacheControl: false,
          ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
        },
        ...(config.streamIdleTimeoutMs === undefined
          ? {}
          : { streamIdleTimeoutMs: config.streamIdleTimeoutMs }),
      }),
    ),
}
