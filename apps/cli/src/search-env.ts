import { braveSearch, deepseekSearch, type SearchHost } from '@jozo-harness/tools-tier1'
import type { JozoHarnessConfig } from './config-file.ts'

/** The environment variable that turns the default web search provider on. */
export const SEARCH_KEY_ENV = 'BRAVE_API_KEY'

/** The key the DeepSeek Search and Fetch APIs read. */
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY'

/** The provider when neither the settings file nor the default names one. */
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
  const key = env[SEARCH_KEY_ENV]
  if (key === undefined || key === '') return undefined
  return braveSearch({ apiKey: key })
}
