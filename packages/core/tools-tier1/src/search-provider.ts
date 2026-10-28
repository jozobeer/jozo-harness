import { Effect } from 'effect'
import { ToolError } from '@jozo-harness/tools'
import type { SearchHit, SearchHost } from './search.ts'

export interface BraveSearchOptions {
  /** Undefined or empty fails each search with the command that stores one. */
  readonly apiKey: string | undefined
  /** Overridable so tests can point at a local server. */
  readonly baseUrl?: string
}

interface BraveResponse {
  readonly web?: {
    readonly results?: ReadonlyArray<{
      readonly title?: string
      readonly url?: string
      readonly description?: string
    }>
  }
}

const failure = (message: string): ToolError => new ToolError({ code: 'execution', message })

/** Brave's web search, as the provider the web_search tool calls. */
export const braveSearch = (options: BraveSearchOptions): SearchHost => ({
  search: (query, limit) => {
    const key = options.apiKey
    if (key === undefined || key === '') {
      return Effect.fail(
        failure('brave search needs BRAVE_API_KEY; run: jzh auth set BRAVE_API_KEY, then retry'),
      )
    }
    return Effect.tryPromise({
      try: async () => {
        const base = options.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search'
        const url = base + '?q=' + encodeURIComponent(query) + '&count=' + String(limit)
        const response = await fetch(url, {
          headers: { accept: 'application/json', 'X-Subscription-Token': key },
        })
        if (!response.ok) throw new Error('status ' + String(response.status))
        const body = (await response.json()) as BraveResponse
        return (body.web?.results ?? []).map((hit): SearchHit => ({
          title: hit.title ?? '',
          url: hit.url ?? '',
          snippet: hit.description ?? '',
        }))
      },
      catch: () => failure('search failed for: ' + query),
    })
  },
})
