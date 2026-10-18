/** The services jozo-harness can hold a key for, by the name a person would say. */
export interface ProviderSecret {
  readonly name: string
  /** The provider part of a `provider/model` route. */
  readonly route: string
  readonly env: string
  readonly baseUrl?: string
  readonly hint: string
}

export const PROVIDERS: ReadonlyArray<ProviderSecret> = [
  {
    name: 'ollama',
    route: 'ollama-cloud',
    env: 'OLLAMA_API_KEY',
    baseUrl: 'https://ollama.com/v1',
    hint: 'https://ollama.com/settings/keys',
  },
  {
    name: 'deepseek',
    route: 'deepseek',
    env: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    hint: 'https://platform.deepseek.com/api_keys',
  },
  {
    name: 'openai',
    route: 'openai',
    env: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    hint: 'https://platform.openai.com/api-keys',
  },
]

export const providerByName = (name: string): ProviderSecret | undefined =>
  PROVIDERS.find((provider) => provider.name === name)

/** The provider that uses an environment variable, when there is one. */
export const providerByEnv = (env: string): ProviderSecret | undefined =>
  PROVIDERS.find((provider) => provider.env === env)

/** The provider served at a base URL, compared without a trailing slash. */
export const providerByBaseUrl = (baseUrl: string): ProviderSecret | undefined =>
  PROVIDERS.find((provider) => provider.baseUrl?.replace(/\/$/, '') === baseUrl.replace(/\/$/, ''))
