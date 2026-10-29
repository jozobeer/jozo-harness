import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  SESSION_FORMAT_VERSION,
  memoryPersistence,
  type SessionEvent,
  type SessionHeader,
} from '../src/index.ts'

const header: SessionHeader = {
  formatVersion: SESSION_FORMAT_VERSION,
  createdAt: 1_000,
  cwd: '/workspace',
}

const message = (seq: number, text: string): SessionEvent => ({
  seq,
  time: 1_000 + seq,
  type: 'user/message',
  data: { text, source: 'user' },
})

const event = (type: 'turn/start' | 'turn/end'): SessionEvent =>
  type === 'turn/start'
    ? { seq: 2, time: 1_002, type, data: { turn: 1 } }
    : { seq: 3, time: 1_003, type, data: { turn: 1, reason: { kind: 'completed' } } }

describe('memoryPersistence', () => {
  test('opens the session it created and hands every append to the next reader', async () => {
    const store = memoryPersistence({ id: () => 'session-1' })
    const created = await Effect.runPromise(store.create(header))
    await Effect.runPromise(created.sink.append(message(2, 'hello')))

    const reopened = await Effect.runPromise(store.open('session-1'))
    expect(reopened.events.map((entry) => entry.type)).toEqual(['session/header', 'user/message'])
    expect(reopened.events).toEqual([
      { seq: 1, time: 1_000, type: 'session/header', data: header },
      message(2, 'hello'),
    ])
    const read = store.read
    if (read === undefined) throw new Error('the memory store must support reads')
    expect(await Effect.runPromise(read('session-1'))).toEqual(reopened.events)
  })

  test('summarises a log from its events, including the first thing the human said', async () => {
    const store = memoryPersistence({ id: () => 'session-2' })
    const created = await Effect.runPromise(store.create(header))
    await Effect.runPromise(created.sink.append(message(2, 'fix the flaky login test')))
    await Effect.runPromise(created.sink.append(event('turn/start')))
    await Effect.runPromise(created.sink.append(event('turn/end')))

    const summary = await Effect.runPromise(store.stat('session-2'))
    expect(summary).toEqual({
      id: 'session-2',
      cwd: '/workspace',
      createdAt: 1_000,
      updatedAt: 1_003,
      title: 'fix the flaky login test',
      empty: false,
    })
    expect(await Effect.runPromise(store.list())).toEqual([summary])
  })

  test('reports a log nobody created as missing instead of inventing one', async () => {
    const store = memoryPersistence()
    const failure = await Effect.runPromise(Effect.flip(store.open('missing')))
    expect(failure.code).toBe('not-found')
    expect(failure.message).toContain('missing')
  })

  test('keeps each store to its own memory, so a second page starts empty', async () => {
    const first = memoryPersistence()
    await Effect.runPromise(first.create(header))
    const second = memoryPersistence()

    expect(await Effect.runPromise(second.list())).toEqual([])
  })
})
