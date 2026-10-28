import { Effect, Schema } from 'effect'
import { ToolError } from '@jozo-harness/tools'
import type { SearchHit, SearchHost } from './search.ts'

/** The Exa search endpoint; tests override the base to stay off the network. */
export const EXA_SEARCH_BASE_URL = 'https://api.exa.ai'

export interface ExaSearchOptions {
  /** Undefined or empty fails each search with the command that stores one. */
  readonly apiKey: string | undefined
  /** Overridable so tests can point at a local server. */
  readonly baseUrl?: string
}

const ExaResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      url: Schema.String,
      text: Schema.optionalKey(Schema.String),
      summary: Schema.optionalKey(Schema.String),
      highlights: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
})

const failure = (message: string): ToolError => new ToolError({ code: 'execution', message })

/** Exa's search API, as the provider the web_search tool calls. */
export const exaSearch = (options: ExaSearchOptions): SearchHost => ({
  search: (query, limit) =>
    Effect.gen(function* () {
      const key = options.apiKey
      if (key === undefined || key === '') {
        return yield* Effect.fail(
          failure('exa search needs EXA_API_KEY; run: jzh auth set EXA_API_KEY, then retry'),
        )
      }
      const endpoint = (options.baseUrl ?? EXA_SEARCH_BASE_URL).replace(/\/+$/u, '') + '/search'
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: {
              'x-api-key': key,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({
              query,
              numResults: Math.min(limit, 100),
              contents: { highlights: true },
            }),
          }),
        catch: (cause) =>
          failure(
            'exa search cannot reach ' +
              endpoint +
              ': ' +
              String(cause) +
              '; check EXA_API_KEY (jzh auth set EXA_API_KEY)',
          ),
      })
      if (!response.ok) {
        return yield* Effect.fail(
          failure(
            'exa search failed at ' +
              endpoint +
              ': HTTP ' +
              String(response.status) +
              '; check EXA_API_KEY (jzh auth set EXA_API_KEY)',
          ),
        )
      }
      const json = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () =>
          failure(
            'exa search got a response that is not JSON from ' + endpoint + '; check the endpoint',
          ),
      })
      const body = yield* Schema.decodeUnknownEffect(ExaResponse)(json).pipe(
        Effect.mapError(() =>
          failure(
            'exa search got an invalid response from ' + endpoint + '; expected results[].url',
          ),
        ),
      )
      return body.results.map((hit): SearchHit => ({
        title: hit.title ?? '',
        url: hit.url,
        snippet: hit.highlights?.join(' ') ?? hit.text ?? hit.summary ?? '',
      }))
    }),
})
