import {
  braveSearch,
  deepseekSearch,
  exaSearch,
  perplexitySearch,
  type SearchHost,
} from '@jozo-harness/tools-tier1'
import type { JozoHarnessConfig } from './config-file.ts'

/** The environment variable that turns the default web search provider on. */
export const SEARCH_KEY_ENV = 'BRAVE_API_KEY'

/** The key the DeepSeek Search and Fetch APIs read. */
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY'

/** The key the Exa search API reads. */
export const EXA_KEY_ENV = 'EXA_API_KEY'

/** The key the Perplexity chat completions API reads. */
export const PERPLEXITY_KEY_ENV = 'PERPLEXITY_API_KEY'

/**
 * The provider the settings name, or brave when only its key is present.
 * A named provider with no key still returns a host, so the first call says
 * which variable is missing instead of silently searching through another.
 */
export const searchFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  settings: JozoHarnessConfig = {},
): SearchHost | undefined => {
  if (settings.search === 'deepseek') {
    return deepseekSearch({
      apiKey: env[DEEPSEEK_KEY_ENV],
      ...(settings.deepseekToolsBaseUrl === undefined
        ? {}
        : { baseUrl: settings.deepseekToolsBaseUrl }),
    })
  }
  if (settings.search === 'exa') return exaSearch({ apiKey: env[EXA_KEY_ENV] })
  if (settings.search === 'perplexity') return perplexitySearch({ apiKey: env[PERPLEXITY_KEY_ENV] })
  const key = env[SEARCH_KEY_ENV]
  if (key === undefined || key === '') return undefined
  return braveSearch({ apiKey: key })
}
