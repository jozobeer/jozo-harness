import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { startStubServer } from '@jozo-harness/test-support-stub'
import { braveSearch, deepseekSearch, exaSearch, perplexitySearch } from '../src/index.ts'

describe('braveSearch', () => {
  test('parses the provider response', async () => {
    let seen: { url: string; token: string } = { url: '', token: '' }
    const server = await startStubServer((request) => {
      seen = {
        url: request.url,
        token: request.headers.get('x-subscription-token') ?? '',
      }
      return Response.json({
        web: {
          results: [
            { title: 'jozo-harness', url: 'https://example.com', description: 'a harness' },
            { url: 'https://example.com/2' },
          ],
        },
      })
    })
    const baseUrl = server.origin + '/search'

    const hits = await Effect.runPromise(
      braveSearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 2),
    )
    await server.stop()

    expect(hits).toEqual([
      { title: 'jozo-harness', url: 'https://example.com', snippet: 'a harness' },
      { title: '', url: 'https://example.com/2', snippet: '' },
    ])
    expect(seen.token).toBe('secret')
    expect(seen.url).toContain('q=jozo-harness')
    expect(seen.url).toContain('count=2')
  })

  test('a failing provider becomes a tool error', async () => {
    const server = await startStubServer(() => new Response('nope', { status: 500 }))
    const baseUrl = server.origin + '/search'

    const message = await Effect.runPromise(
      Effect.match(braveSearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )
    await server.stop()

    expect(message).toContain('search failed')
  })
})

describe('deepseekSearch', () => {
  test('posts the query and maps the provider response', async () => {
    let seen = { method: '', path: '', auth: '', contentType: '', body: {} as unknown }
    const server = await startStubServer(async (request) => {
      seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        auth: request.headers.get('authorization') ?? '',
        contentType: request.headers.get('content-type') ?? '',
        body: await request.json(),
      }
      return Response.json({
        results: [
          {
            url: 'https://example.com',
            title: 'jozo-harness',
            snippet: 'a harness',
            date: '2026-10-18',
          },
          { url: 'https://example.com/2', title: '', snippet: '', date: null },
        ],
      })
    })
    const baseUrl = server.origin + '/tools'

    const hits = await Effect.runPromise(
      deepseekSearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 2),
    )
    await server.stop()

    expect(hits).toEqual([
      { title: 'jozo-harness', url: 'https://example.com', snippet: 'a harness' },
      { title: '', url: 'https://example.com/2', snippet: '' },
    ])
    expect(seen.method).toBe('POST')
    expect(seen.path).toBe('/tools/search')
    expect(seen.auth).toBe('Bearer secret')
    expect(seen.contentType).toContain('application/json')
    expect(seen.body).toEqual({ query: 'jozo-harness', count: 2, need_content: false })
  })

  test('a missing key is a tool error that says how to store one', async () => {
    const message = await Effect.runPromise(
      Effect.match(deepseekSearch({ apiKey: undefined }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )

    expect(message).toContain('DEEPSEEK_API_KEY')
    expect(message).toContain('jzh auth add deepseek')
  })

  test('an endpoint failure names the endpoint and where to change it', async () => {
    const server = await startStubServer(() => new Response('nope', { status: 500 }))
    const baseUrl = server.origin + '/tools'

    const message = await Effect.runPromise(
      Effect.match(deepseekSearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )
    await server.stop()

    expect(message).toContain('/tools/search')
    expect(message).toContain('HTTP 500')
    expect(message).toContain('deepseekToolsBaseUrl')
  })

  test('an invalid body is a tool error, not an empty result', async () => {
    const server = await startStubServer(() => Response.json({ results: [{ url: 'x' }] }))
    const baseUrl = server.origin + '/tools'

    const message = await Effect.runPromise(
      Effect.match(deepseekSearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )
    await server.stop()

    expect(message).toContain('invalid response')
  })
})

describe('exaSearch', () => {
  test('posts the query with the api key and maps the provider response', async () => {
    let seen = { method: '', path: '', apiKey: '', contentType: '', body: {} as unknown }
    const server = await startStubServer(async (request) => {
      seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        apiKey: request.headers.get('x-api-key') ?? '',
        contentType: request.headers.get('content-type') ?? '',
        body: await request.json(),
      }
      return Response.json({
        results: [
          {
            title: 'jozo-harness',
            url: 'https://example.com',
            highlights: ['a harness', 'for agents'],
          },
          { url: 'https://example.com/2', text: 'fallback text' },
          { url: 'https://example.com/3', summary: 'a summary' },
        ],
      })
    })
    const baseUrl = server.origin

    const hits = await Effect.runPromise(
      exaSearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 2),
    )
    await server.stop()

    expect(hits).toEqual([
      { title: 'jozo-harness', url: 'https://example.com', snippet: 'a harness for agents' },
      { title: '', url: 'https://example.com/2', snippet: 'fallback text' },
      { title: '', url: 'https://example.com/3', snippet: 'a summary' },
    ])
    expect(seen.method).toBe('POST')
    expect(seen.path).toBe('/search')
    expect(seen.apiKey).toBe('secret')
    expect(seen.contentType).toContain('application/json')
    expect(seen.body).toEqual({
      query: 'jozo-harness',
      numResults: 2,
      contents: { highlights: true },
    })
  })

  test('a missing key is a tool error that names the variable', async () => {
    const message = await Effect.runPromise(
      Effect.match(exaSearch({ apiKey: undefined }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )

    expect(message).toContain('EXA_API_KEY')
    expect(message).toContain('jzh auth set EXA_API_KEY')
  })

  test('an endpoint failure names the endpoint and status', async () => {
    const server = await startStubServer(() => new Response('nope', { status: 500 }))
    const baseUrl = server.origin

    const message = await Effect.runPromise(
      Effect.match(exaSearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )
    await server.stop()

    expect(message).toContain('/search')
    expect(message).toContain('HTTP 500')
    expect(message).toContain('EXA_API_KEY')
  })

  test('an invalid body is a tool error, not an empty result', async () => {
    const server = await startStubServer(() => Response.json({ results: [{ title: 'x' }] }))
    const baseUrl = server.origin

    const message = await Effect.runPromise(
      Effect.match(exaSearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )
    await server.stop()

    expect(message).toContain('invalid response')
    expect(message).toContain('results[].url')
  })
})

describe('perplexitySearch', () => {
  test('posts the query and maps the grounded search results', async () => {
    let seen = { method: '', path: '', auth: '', contentType: '', body: {} as unknown }
    const server = await startStubServer(async (request) => {
      seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        auth: request.headers.get('authorization') ?? '',
        contentType: request.headers.get('content-type') ?? '',
        body: await request.json(),
      }
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'an answer' } }],
        search_results: [
          {
            title: 'jozo-harness',
            url: 'https://example.com',
            snippet: 'a harness',
            date: '2026-10-18',
          },
          { url: 'https://example.com/2' },
        ],
      })
    })
    const baseUrl = server.origin

    const hits = await Effect.runPromise(
      perplexitySearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 2),
    )
    await server.stop()

    expect(hits).toEqual([
      { title: 'jozo-harness', url: 'https://example.com', snippet: 'a harness' },
      { title: '', url: 'https://example.com/2', snippet: '' },
    ])
    expect(seen.method).toBe('POST')
    expect(seen.path).toBe('/chat/completions')
    expect(seen.auth).toBe('Bearer secret')
    expect(seen.contentType).toContain('application/json')
    expect(seen.body).toEqual({
      model: 'sonar',
      messages: [{ role: 'user', content: 'jozo-harness' }],
    })
  })

  test('falls back to the citation urls when search_results is absent', async () => {
    const server = await startStubServer(() =>
      Response.json({
        choices: [{ message: { content: 'an answer' } }],
        citations: ['https://example.com', 'https://example.com/2'],
      }),
    )
    const baseUrl = server.origin

    const hits = await Effect.runPromise(
      perplexitySearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 5),
    )
    await server.stop()

    expect(hits).toEqual([
      { title: '', url: 'https://example.com', snippet: '' },
      { title: '', url: 'https://example.com/2', snippet: '' },
    ])
  })

  test('a missing key is a tool error that names the variable', async () => {
    const message = await Effect.runPromise(
      Effect.match(perplexitySearch({ apiKey: undefined }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )

    expect(message).toContain('PERPLEXITY_API_KEY')
    expect(message).toContain('jzh auth set PERPLEXITY_API_KEY')
  })

  test('an endpoint failure names the endpoint and status', async () => {
    const server = await startStubServer(() => new Response('nope', { status: 401 }))
    const baseUrl = server.origin

    const message = await Effect.runPromise(
      Effect.match(perplexitySearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )
    await server.stop()

    expect(message).toContain('/chat/completions')
    expect(message).toContain('HTTP 401')
    expect(message).toContain('PERPLEXITY_API_KEY')
  })

  test('an invalid body is a tool error, not an empty result', async () => {
    const server = await startStubServer(() => Response.json({ choices: [] }))
    const baseUrl = server.origin

    const message = await Effect.runPromise(
      Effect.match(perplexitySearch({ apiKey: 'secret', baseUrl }).search('jozo-harness', 1), {
        onFailure: (error) => error.message,
        onSuccess: () => 'ok',
      }),
    )
    await server.stop()

    expect(message).toContain('invalid response')
    expect(message).toContain('search_results[].url or citations[]')
  })
})
