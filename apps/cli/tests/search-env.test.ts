import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { startStubServer } from '@jozo-harness/test-support-stub'
import { SEARCH_KEY_ENV, searchFromEnv } from '../src/index.ts'

describe('searchFromEnv', () => {
  test('no key means no provider', () => {
    expect(searchFromEnv({})).toBeUndefined()
    expect(searchFromEnv({ [SEARCH_KEY_ENV]: '' })).toBeUndefined()
  })

  test('a key gives a provider', () => {
    const host = searchFromEnv({ [SEARCH_KEY_ENV]: 'secret' })

    expect(host).toBeDefined()
    expect(typeof host?.search).toBe('function')
  })

  test('the settings choose the deepseek provider and its endpoint', async () => {
    let path = ''
    const server = await startStubServer((request) => {
      path = new URL(request.url).pathname
      return Response.json({
        results: [{ url: 'https://example.com', title: 'jozo', snippet: 'a harness' }],
      })
    })

    const host = searchFromEnv(
      { DEEPSEEK_API_KEY: 'secret' },
      { search: 'deepseek', deepseekToolsBaseUrl: server.origin + '/tools' },
    )
    const hits = await Effect.runPromise(host?.search('jozo', 1) ?? Effect.die('no provider'))
    await server.stop()

    expect(path).toBe('/tools/search')
    expect(hits).toEqual([{ title: 'jozo', url: 'https://example.com', snippet: 'a harness' }])
  })

  test('deepseek without a key still registers a provider that says how to add one', async () => {
    const host = searchFromEnv({}, { search: 'deepseek' })
    const message = await Effect.runPromise(
      Effect.match(host?.search('jozo', 1) ?? Effect.die('no provider'), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )

    expect(message).toContain('DEEPSEEK_API_KEY')
    expect(message).toContain('jzh auth add deepseek')
  })

  test('a deepseek key alone does not change the default provider', () => {
    expect(searchFromEnv({ DEEPSEEK_API_KEY: 'secret' })).toBeUndefined()
  })
})
