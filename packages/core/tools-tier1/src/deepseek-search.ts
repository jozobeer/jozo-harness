import { Effect, Schema } from 'effect'
import { ToolError } from '@jozo-harness/tools'
import type { SearchHit, SearchHost } from './search.ts'

/** The Search and Fetch API base including its `/v1/tools` prefix. */
export const DEEPSEEK_WEB_API_BASE_URL = 'https://api.deepseek.com/v1/tools'

export interface DeepSeekSearchOptions {
  /** Undefined or empty fails each search with the command that stores one. */
  readonly apiKey: string | undefined
  /** Overridable so tests can point at a local server. */
  readonly baseUrl?: string
}

const SearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.String,
      snippet: Schema.String,
      date: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})

const failure = (message: string): ToolError => new ToolError({ code: 'execution', message })

/** DeepSeek's Search API, as the provider the web_search tool calls. */
export const deepseekSearch = (options: DeepSeekSearchOptions): SearchHost => ({
  search: (query, limit) =>
    Effect.gen(function* () {
      const key = options.apiKey
      if (key === undefined || key === '') {
        return yield* Effect.fail(
          failure('deepseek search needs DEEPSEEK_API_KEY; run: jzh auth add deepseek, then retry'),
        )
      }
      const endpoint =
        (options.baseUrl ?? DEEPSEEK_WEB_API_BASE_URL).replace(/\/+$/u, '') + '/search'
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: 'Bearer ' + key,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              query,
              count: Math.min(limit, 50),
              need_content: false,
            }),
          }),
        catch: (cause) =>
          failure(
            'deepseek search cannot reach ' +
              endpoint +
              ': ' +
              String(cause) +
              '; set deepseekToolsBaseUrl to the endpoint to use',
          ),
      })
      if (!response.ok) {
        return yield* Effect.fail(
          failure(
            'deepseek search failed at ' +
              endpoint +
              ': HTTP ' +
              String(response.status) +
              '; check DEEPSEEK_API_KEY (jzh auth add deepseek) and deepseekToolsBaseUrl',
          ),
        )
      }
      const json = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () =>
          failure(
            'deepseek search got a response that is not JSON from ' +
              endpoint +
              '; check deepseekToolsBaseUrl',
          ),
      })
      const body = yield* Schema.decodeUnknownEffect(SearchResponse)(json).pipe(
        Effect.mapError(() =>
          failure(
            'deepseek search got an invalid response from ' +
              endpoint +
              '; check deepseekToolsBaseUrl',
          ),
        ),
      )
      return body.results.map((hit): SearchHit => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
      }))
    }),
})
