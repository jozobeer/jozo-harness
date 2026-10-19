import { Llm } from '@jozo-harness/llm'
import type { Plugin } from '@jozo-harness/kernel'
import { Effect, Layer, Schema } from 'effect'
import { openAiAdapter } from './adapter.ts'

/** How long a run waits for the local daemon before it takes the configured URL. */
export const DEFAULT_LOCAL_PROBE_TIMEOUT_MS = 300

/** Settings of the OpenAI-compatible provider. */
export const llmOpenAiConfig = Schema.Struct({
  baseUrl: Schema.String,
  /** Name of the environment variable that holds the key. */
  apiKeyEnv: Schema.String,
  /**
   * OpenAI-compatible base URL of a local daemon that serves the same models
   * with a prompt cache. The run probes it once at startup and falls back to
   * `baseUrl` when it does not answer.
   */
  localBaseUrl: Schema.optionalKey(Schema.String),
  /** How long the startup probe waits for the local daemon, in milliseconds. */
  localProbeTimeoutMs: Schema.optionalKey(Schema.Int),
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
 * Whether a local daemon answers its OpenAI-compatible model list. The probe is
 * deliberately cheap and silent: an absent daemon is a normal fallback, not a
 * failure of the run.
 */
export const localDaemonReachable = async (
  baseUrl: string,
  timeoutMs: number,
  send: typeof fetch = fetch,
): Promise<boolean> => {
  try {
    const response = await send(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

/** The probe the route builder runs; a test injects its own answer. */
export type LocalProbe = (baseUrl: string, timeoutMs: number) => Promise<boolean>

export interface LlmRoute {
  readonly baseUrl: string
  readonly local: boolean
}

/**
 * The route one run uses. A local daemon wins only when the row names one and
 * the probe answered, so a laptop without Ollama keeps the cloud route.
 */
export const resolveRoute = (
  baseUrl: string,
  localBaseUrl: string | undefined,
  localReachable: boolean,
): LlmRoute =>
  localBaseUrl !== undefined && localReachable
    ? { baseUrl: localBaseUrl, local: true }
    : { baseUrl, local: false }

/**
 * Loader definition for the OpenAI-compatible adapter. The capability set is
 * the one the recording confirmed: no `tool_choice`, no prompt cache control,
 * and the effort words the row (or the wire's own) declares.
 */
export const makeLlmOpenAiPlugin = (
  probe: LocalProbe = localDaemonReachable,
): Plugin<typeof llmOpenAiConfig.Type, Llm, never> => ({
  name: '@jozo-harness/llm-openai',
  config: llmOpenAiConfig,
  provides: [Llm],
  requires: [],
  layer: (config) => {
    const localBaseUrl = config.localBaseUrl
    return Layer.effect(
      Llm,
      Effect.gen(function* () {
        const reachable =
          localBaseUrl === undefined
            ? false
            : yield* Effect.promise(() =>
                probe(localBaseUrl, config.localProbeTimeoutMs ?? DEFAULT_LOCAL_PROBE_TIMEOUT_MS),
              )
        const route = resolveRoute(config.baseUrl, localBaseUrl, reachable)
        if (localBaseUrl !== undefined && !route.local) {
          yield* Effect.logWarning(
            `local daemon at ${localBaseUrl} did not answer; using ${config.baseUrl}`,
          )
        }
        return openAiAdapter({
          baseUrl: route.baseUrl,
          apiKey: () => process.env[config.apiKeyEnv],
          allowAnonymous: route.local,
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
        })
      }),
    )
  },
})

/** The bundled route: a reachable local daemon is preferred over the cloud URL. */
export const llmOpenAiPlugin = makeLlmOpenAiPlugin()
