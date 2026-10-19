import { describe, expect, test } from 'vitest'
import {
  addressSession,
  keepBusyEnter,
  keptBusyEnter,
  pageSocket,
  socketAt,
  tokenOfSearch,
} from '../dom.ts'

describe('the socket a page opens', () => {
  test('carries the token the page was opened with', () => {
    expect(socketAt('http:', '127.0.0.1:3000', 'abc')).toBe('ws://127.0.0.1:3000/ui?token=abc')
    expect(socketAt('https:', 'example.test', 'a b')).toBe('wss://example.test/ui?token=a%20b')
    expect(socketAt('http:', '127.0.0.1:3000')).toBe('ws://127.0.0.1:3000/ui')
  })

  test('reads the token from the search string, and nothing when it names none', () => {
    expect(tokenOfSearch('?session=s-1&token=abc')).toBe('abc')
    expect(tokenOfSearch('?token=abc')).toBe('abc')
    expect(tokenOfSearch('?session=s-1')).toBeUndefined()
    expect(tokenOfSearch('?token=')).toBeUndefined()
  })
})

describe('the token a page is opened with', () => {
  test('leaves the address after the socket reads it, keeping the session named there', () => {
    sessionStorage.clear()
    window.history.replaceState(null, '', '/?token=abc&session=s-1')

    expect(pageSocket()).toBe('ws://localhost:3000/ui?token=abc')
    expect(window.location.search).toBe('?session=s-1')
  })

  test('survives a reload without the token in the address', () => {
    sessionStorage.clear()
    window.history.replaceState(null, '', '/?token=abc')
    pageSocket()

    window.history.replaceState(null, '', '/')
    expect(pageSocket()).toBe('ws://localhost:3000/ui?token=abc')
  })

  test('never writes the token back while addressing a session', () => {
    sessionStorage.clear()
    window.history.replaceState(null, '', '/?token=abc&session=s-1')
    pageSocket()

    addressSession('s-2')
    expect(window.location.search).toBe('?session=s-2')
    expect(pageSocket()).toBe('ws://localhost:3000/ui?token=abc')
  })
})

describe('the busy-Enter choice a page keeps', () => {
  test('reads queue until the reader keeps a mode, and then that mode', () => {
    localStorage.clear()
    expect(keptBusyEnter()).toBe('queue')
    keepBusyEnter('steer')
    expect(keptBusyEnter()).toBe('steer')
    keepBusyEnter('queue')
    expect(keptBusyEnter()).toBe('queue')
  })
})
