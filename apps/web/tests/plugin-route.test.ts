import { describe, expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { answerPlugins, codeExchange, type PluginsGate } from '../src/server/index.ts'

describe('the plugin route', () => {
  test('answers a change whose body stream fails as one it cannot read', async () => {
    const gate: PluginsGate = {
      plugins: {
        view: () => ({ rows: [], catalog: [], failures: [] }),
        known: () => [],
        change: async () => ({ ok: true }),
      },
      port: 1,
      publicOrigin: undefined,
      tailnet: undefined,
      token: 'secret',
      codes: codeExchange(() => 0),
    }
    const answer = { status: 0, body: '' }
    const response = {
      writeHead: (status: number) => {
        answer.status = status
      },
      end: (body?: string) => {
        answer.body = body ?? ''
      },
    } as unknown as ServerResponse
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/plugins',
      headers: { cookie: 'jzh_web=secret' },
    }) as unknown as IncomingMessage

    const answering = answerPlugins(request, response, '/plugins', gate)
    // The client hung up after the request line: the body never becomes a change.
    request.emit('error', new Error('the socket reset'))
    const handled = await answering

    expect(handled).toBe(true)
    expect(answer).toEqual({ status: 400, body: 'the plugin change could not be read' })
  })
})
