import { Llm, outboundFetch } from '@jozo-harness/llm'
import type { Plugin } from '@jozo-harness/kernel'
import { Layer, Schema } from 'effect'
import { deepSeekMessagesAdapter } from './adapter.ts'

/** Settings of the official DeepSeek Messages endpoint. */
export const llmDeepSeekConfig = Schema.Struct({
  /** Messages root, e.g. https://api.deepseek.com/anthropic; a missing /v1 is added. */
  baseUrl: Schema.String,
  /** Name of the environment variable that holds the key. */
  apiKeyEnv: Schema.String,
  /** The bound one Messages response may grow to. Defaults to 8192. */
  maxTokens: Schema.optionalKey(Schema.Int),
  /**
   * Top-level fields the official endpoint takes beyond the Messages API, such
   * as `thinking`. Absent sends none: the row opts in, so a compatible endpoint
   * never receives a field it did not name.
   */
  extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  /** Headers every request sends, for an endpoint that names the client. */
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The routed model's context window in tokens, for compaction pressure. */
  contextWindow: Schema.optionalKey(Schema.Int),
})

/**
 * Loader definition for the official Messages adapter. A profile or settings
 * row names this plugin instead of the OpenAI-compatible one; the endpoint is
 * never inferred from a URL, so switching the route is always explicit.
 */
export const makeLlmDeepSeekPlugin = (
  send: typeof fetch = outboundFetch,
): Plugin<typeof llmDeepSeekConfig.Type, Llm, never> => ({
  name: '@jozo-harness/llm-deepseek',
  config: llmDeepSeekConfig,
  provides: [Llm],
  requires: [],
  layer: (config) =>
    Layer.succeed(
      Llm,
      deepSeekMessagesAdapter({
        baseUrl: config.baseUrl,
        apiKey: () => process.env[config.apiKeyEnv],
        fetch: send,
        ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
        ...(config.extensions === undefined ? {} : { extensions: config.extensions }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        capabilities: {
          toolChoice: false,
          reasoningEffort: null,
          images: 'none',
          promptCacheControl: false,
          ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
        },
      }),
    ),
})

/** The bundled official route: the row's base URL and key decide where it sends. */
export const llmDeepSeekPlugin = makeLlmDeepSeekPlugin()
