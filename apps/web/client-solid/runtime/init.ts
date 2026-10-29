/** What the page hands its worker before the first turn. */
export interface BrowserWorkerInit {
  readonly kind: 'init'
  readonly route: string
  readonly baseUrl: string
  readonly apiKey: string
}

/** The part of `sessionStorage` the page reads the key out of; it never reaches the URL. */
export interface StorageLike {
  readonly getItem: (key: string) => string | null
}

export const API_KEY_STORAGE_KEY = 'jzh.browser.apiKey'
export const DEFAULT_ROUTE = 'deepseek/deepseek-chat'
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Reads the message that tells a worker which model to call. The page posts it
 * once, right after creating the worker, so the key stays out of the script URL.
 */
export const parseBrowserWorkerInit = (data: unknown): BrowserWorkerInit | undefined => {
  if (!isRecord(data) || data['kind'] !== 'init') return undefined
  const route = data['route']
  const baseUrl = data['baseUrl']
  const apiKey = data['apiKey']
  if (typeof route !== 'string' || typeof baseUrl !== 'string' || typeof apiKey !== 'string') {
    return undefined
  }
  return { kind: 'init', route, baseUrl, apiKey }
}

/**
 * The standalone page names its model in the address, and keeps the key in
 * session storage: a reload keeps the settings, closing the tab drops the key.
 */
export const browserWorkerInitFrom = (search: string, storage: StorageLike): BrowserWorkerInit => {
  const params = new URLSearchParams(search)
  const route = params.get('route')?.trim() ?? ''
  const baseUrl = params.get('baseUrl')?.trim() ?? ''
  return {
    kind: 'init',
    route: route === '' ? DEFAULT_ROUTE : route,
    baseUrl: baseUrl === '' ? DEFAULT_BASE_URL : baseUrl,
    apiKey: storage.getItem(API_KEY_STORAGE_KEY) ?? '',
  }
}
