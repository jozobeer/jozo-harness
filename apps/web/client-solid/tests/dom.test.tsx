import { describe, expect, test } from 'vitest'
import { socketAt, tokenOfSearch } from '../dom.ts'

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
