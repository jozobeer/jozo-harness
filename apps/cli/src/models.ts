import type { PluginRow } from '@jozo-harness/kernel'
import { Effect, Schema } from 'effect'
import { providerByBaseUrl } from './providers.ts'

/** Where to ask for models, and the provider part of the routes it answers with. */
export interface ModelEndpoint {
  readonly provider: string
  readonly baseUrl: string
  readonly apiKeyEnv: string
  /** A reference in the credentials store, used when the environment has no key. */
  readonly apiKeyRef?: string
}

const LLM_ROW = '@jozo-harness/llm-openai'
const LIST_TIMEOUT_MS = 30_000

const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
})

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A base URL the provider table does not know is named by its host. */
const providerOf = (baseUrl: string): string =>
  providerByBaseUrl(baseUrl)?.route ?? URL.parse(baseUrl)?.hostname ?? baseUrl

/** The endpoint of the profile's OpenAI-compatible row, when it has one. */
export function modelEndpointOf(rows: ReadonlyArray<PluginRow>): ModelEndpoint | undefined {
  const row = rows.find((candidate) => candidate.name === LLM_ROW && candidate.disabled !== true)
  const config = row?.config
  if (!isRecord(config)) return undefined
  const { baseUrl, apiKeyEnv, apiKeyRef } = config
  if (typeof baseUrl !== 'string' || typeof apiKeyEnv !== 'string') return undefined
  return {
    provider: providerOf(baseUrl),
    baseUrl,
    apiKeyEnv,
    ...(typeof apiKeyRef === 'string' && apiKeyRef !== '' ? { apiKeyRef } : {}),
  }
}

const authorization = (key: string | undefined): Record<string, string> =>
  key === undefined || key === '' ? {} : { authorization: 'Bearer ' + key }

/**
 * Asks the provider's `GET /models` and returns every model as a sorted
 * `provider/model` route. The key is sent when the environment has one.
 */
export function listModels(
  endpoint: ModelEndpoint,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<ReadonlyArray<string>, Error> {
  const url = endpoint.baseUrl.replace(/\/$/, '') + '/models'
  const failure = (detail: string) => new Error('cannot list models from ' + url + ': ' + detail)
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          headers: authorization(env[endpoint.apiKeyEnv]),
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        }),
      catch: (cause) => failure(String(cause)),
    })
    if (!response.ok) {
      const body = yield* Effect.promise(() => response.text())
      return yield* Effect.fail(failure('HTTP ' + response.status + ' ' + body.slice(0, 200)))
    }
    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => failure('the response is not JSON'),
    })
    const list = yield* Schema.decodeUnknownEffect(ModelList)(json).pipe(
      Effect.mapError(() => failure('the response is not a model list')),
    )
    if (list.data.length === 0) return yield* Effect.fail(failure('the provider lists no models'))
    return list.data.map((model) => endpoint.provider + '/' + model.id).sort()
  })
}
