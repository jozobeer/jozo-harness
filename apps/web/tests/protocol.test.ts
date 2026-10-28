import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { RpcSerialization } from 'effect/rpc'
import { makeWebProtocol } from '../src/server/index.ts'

describe('the web socket protocol', () => {
  test('counts the sockets it attaches and forgets one when the page closes', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const { protocol, attach } = yield* makeWebProtocol
        const before = [...(yield* protocol.clientIds)]
        const connection = attach(() => undefined)
        const attached = [...(yield* protocol.clientIds)]
        connection.close()
        const closed = [...(yield* protocol.clientIds)]
        return { before, attached, closed }
      }).pipe(Effect.provide(RpcSerialization.layerJson)),
    )

    expect(observed).toEqual({ before: [], attached: [0], closed: [] })
  })
})
