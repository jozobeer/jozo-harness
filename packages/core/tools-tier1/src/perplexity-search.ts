import { Effect, Schema } from 'effect'
import { ToolError } from '@jozo-harness/tools'
import type { SearchHit, SearchHost } from './search.ts'

/** The Perplexity chat endpoint; tests override the base to stay off the network. */
export const PERPLEXITY_CHAT_BASE_URL = 'https://api.perplexity.ai'

/** The Sonar model both answers and grounds the search results. */
export const PERPLEXITY_SEARCH_MODEL = 'sonar'

export interface PerplexitySearchOptions {
  /** Undefined or empty fails each search with the command that stores one. */
  readonly apiKey: string | undefined
  /** Overridable so tests can point at a local server. */
  readonly baseUrl?: string
}

const PerplexitySource = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  url: Schema.String,
  snippet: Schema.optionalKey(Schema.String),
})

const PerplexityResponse = Schema.Struct({
  search_results: Schema.optionalKey(Schema.Array(PerplexitySource)),
  citations: Schema.optionalKey(Schema.Array(Schema.String)),
})

const failure = (message: string): ToolError => new ToolError({ code: 'execution', message })

const hitOfSource = (source: typeof PerplexitySource.Type): SearchHit => ({
  title: source.title ?? '',
  url: source.url,
  snippet: source.snippet ?? '',
})

/**
 * Perplexity's chat completions API, as the provider the web_search tool calls.
 * Its grounded sources are the hits; the synthesized answer is not one of them.
 */
export const perplexitySearch = (options: PerplexitySearchOptions): SearchHost => ({
  search: (query, limit) =>
    Effect.gen(function* () {
      const key = options.apiKey
      if (key === undefined || key === '') {
        return yield* Effect.fail(
          failure(
            'perplexity search needs PERPLEXITY_API_KEY; run: jzh auth set PERPLEXITY_API_KEY, then retry',
          ),
        )
      }
      const endpoint =
        (options.baseUrl ?? PERPLEXITY_CHAT_BASE_URL).replace(/\/+$/u, '') + '/chat/completions'
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
              model: PERPLEXITY_SEARCH_MODEL,
              messages: [{ role: 'user', content: query }],
            }),
          }),
        catch: (cause) =>
          failure(
            'perplexity search cannot reach ' +
              endpoint +
              ': ' +
              String(cause) +
              '; check PERPLEXITY_API_KEY (jzh auth set PERPLEXITY_API_KEY)',
          ),
      })
      if (!response.ok) {
        return yield* Effect.fail(
          failure(
            'perplexity search failed at ' +
              endpoint +
              ': HTTP ' +
              String(response.status) +
              '; check PERPLEXITY_API_KEY (jzh auth set PERPLEXITY_API_KEY)',
          ),
        )
      }
      const json = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () =>
          failure(
            'perplexity search got a response that is not JSON from ' +
              endpoint +
              '; check the endpoint',
          ),
      })
      const body = yield* Schema.decodeUnknownEffect(PerplexityResponse)(json).pipe(
        Effect.mapError(() =>
          failure(
            'perplexity search got an invalid response from ' +
              endpoint +
              '; expected search_results[].url or citations[]',
          ),
        ),
      )
      if (body.search_results !== undefined) {
        return body.search_results.slice(0, Math.min(limit, 50)).map(hitOfSource)
      }
      if (body.citations !== undefined) {
        return body.citations.slice(0, Math.min(limit, 50)).map(
          (url): SearchHit => ({ title: '', url, snippet: '' }),
        )
      }
      return yield* Effect.fail(
        failure(
          'perplexity search got an invalid response from ' +
            endpoint +
            '; expected search_results[].url or citations[]',
        ),
      )
    }),
})
