import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { listMcpResources, readMcpResource, type McpClientShape } from '../src/index.ts'

interface CapturedRequest {
  readonly method: string
  readonly params?: unknown
}

const stubClient = (answer: unknown, requests: Array<CapturedRequest>): McpClientShape => ({
  request: (method, params) =>
    Effect.sync(() => {
      requests.push(params === undefined ? { method } : { method, params })
      return answer
    }),
  close: () => Effect.void,
})

const resourcesDeclared = { capabilities: { resources: {} } }

describe('listMcpResources', () => {
  test('normalizes each listed resource to uri, name, and mimeType', async () => {
    const requests: Array<CapturedRequest> = []
    const client = stubClient(
      {
        resources: [
          { uri: 'file:///one', name: 'One', mimeType: 'text/plain', description: 'ignored' },
          { name: 'no uri' },
          { uri: 'file:///two' },
        ],
      },
      requests,
    )

    const listed = await Effect.runPromise(listMcpResources(client, resourcesDeclared))

    expect(listed).toEqual([
      { uri: 'file:///one', name: 'One', mimeType: 'text/plain' },
      { uri: 'file:///two' },
    ])
    expect(requests).toEqual([{ method: 'resources/list' }])
  })

  test('fails with unavailable, without asking, when the server has no resources capability', async () => {
    const requests: Array<CapturedRequest> = []
    const client = stubClient({ resources: [{ uri: 'file:///one' }] }, requests)

    const error = await Effect.runPromise(
      Effect.flip(listMcpResources(client, { capabilities: {} })),
    )

    expect(error.code).toBe('unavailable')
    expect(error.message).toContain('resources')
    expect(requests).toEqual([])
  })
})

describe('readMcpResource', () => {
  test('returns text contents and marks a blob as unsupported', async () => {
    const requests: Array<CapturedRequest> = []
    const client = stubClient(
      {
        contents: [
          { uri: 'file:///one', mimeType: 'text/plain', text: 'hello' },
          { uri: 'file:///binary', blob: 'AAEC' },
        ],
      },
      requests,
    )

    const read = await Effect.runPromise(readMcpResource(client, resourcesDeclared, 'file:///one'))

    expect(read).toEqual({
      contents: [{ uri: 'file:///one', mimeType: 'text/plain', text: 'hello' }],
      unsupported: [{ uri: 'file:///binary', reason: 'blob' }],
    })
    expect(requests).toEqual([{ method: 'resources/read', params: { uri: 'file:///one' } }])
  })
})
