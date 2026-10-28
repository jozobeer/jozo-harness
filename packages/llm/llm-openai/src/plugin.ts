import { Llm, outboundFetch } from '@jozo-harness/llm'
import type { Plugin } from '@jozo-harness/kernel'
import { Layer, Schema } from 'effect'
import { openAiAdapter } from './adapter.ts'

/** Settings of the OpenAI-compatible provider. */
export const llmOpenAiConfig = Schema.Struct({
  baseUrl: Schema.String,
  /** Name of the environment variable that holds the key. */
  apiKeyEnv: Schema.String,
  /**
   * OpenAI-compatible base URL of the local daemon that serves the same models
   * with a prompt cache. When the row names one, every request goes there; the
   * run assumes the daemon is up, as dsh does. An empty value turns the local
   * route off, and requests use `baseUrl`, which also remains the endpoint
   * `jzh models` lists from.
   */
  localBaseUrl: Schema.optionalKey(Schema.String),
  /**
   * Headers every request sends, for an endpoint that names the client or wants
   * routing affinity. The value is static, so a per-conversation id cannot be
   * derived here.
   */
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
 * The name a local Ollama daemon knows a cloud model by. Ollama keeps cloud
 * models under a `:cloud` tag, or a `-cloud` suffix when the route names an
 * explicit tag, while the cloud endpoint and the route use the bare name. The
 * route is what the page and the log show, so the translation belongs at the
 * wire rather than in the route.
 */
export const localOllamaModelName = (model: string): string => {
  if (model.endsWith(':cloud') || model.endsWith('-cloud')) return model
  return model.includes(':') ? model + '-cloud' : model + ':cloud'
}

/**
 * Loader definition for the OpenAI-compatible adapter. The capability set is
 * the one the recording confirmed: no `tool_choice`, no prompt cache control,
 * and the effort words the row (or the wire's own) declares.
 */
export const makeLlmOpenAiPlugin = (
  send: typeof fetch = outboundFetch,
): Plugin<typeof llmOpenAiConfig.Type, Llm, never> => ({
  name: '@jozo-harness/llm-openai',
  config: llmOpenAiConfig,
  provides: [Llm],
  requires: [],
  layer: (config) => {
    // An empty URL is how a settings row opts out of the local route.
    const localBaseUrl = config.localBaseUrl === '' ? undefined : config.localBaseUrl
    const local = localBaseUrl !== undefined
    return Layer.succeed(
      Llm,
      openAiAdapter({
        baseUrl: localBaseUrl ?? config.baseUrl,
        apiKey: () => process.env[config.apiKeyEnv],
        allowAnonymous: local,
        // The daemon keeps cloud models under its own names, while the route
        // keeps the name the page and the settings use.
        ...(local ? { modelName: localOllamaModelName } : {}),
        fetch: send,
        ...(config.headers === undefined ? {} : { headers: config.headers }),
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
    )
  },
})

/** The bundled route: a named local daemon takes every request. */
export const llmOpenAiPlugin = makeLlmOpenAiPlugin()
