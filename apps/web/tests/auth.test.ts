import { describe, expect, test } from 'vitest'
import { hostAllowed, originAllowed, tokenFromUrl, tokenMatches } from '../src/server/auth.ts'

describe('the gate in front of the web socket', () => {
  test('reads the token a url carries, and nothing when it names none', () => {
    expect(tokenFromUrl('/ui?token=abc')).toBe('abc')
    expect(tokenFromUrl('/ui?session=s-1&token=abc')).toBe('abc')
    expect(tokenFromUrl('/ui')).toBeUndefined()
    expect(tokenFromUrl('/ui?token=')).toBeUndefined()
  })

  test('accepts only a loopback host at the port the server bound', () => {
    expect(hostAllowed('127.0.0.1:4310', 4310)).toBe(true)
    expect(hostAllowed('localhost:4310', 4310)).toBe(true)
    expect(hostAllowed('127.0.0.1:4311', 4310)).toBe(false)
    expect(hostAllowed('evil.example:4310', 4310)).toBe(false)
    expect(hostAllowed(undefined, 4310)).toBe(false)
  })

  test('accepts the page origin, and a client that names no origin', () => {
    expect(originAllowed('http://127.0.0.1:4310', 4310)).toBe(true)
    expect(originAllowed('http://localhost:4310', 4310)).toBe(true)
    expect(originAllowed(undefined, 4310)).toBe(true)
    expect(originAllowed('http://evil.example', 4310)).toBe(false)
    expect(originAllowed('null', 4310)).toBe(false)
    expect(originAllowed('https://127.0.0.1:4310', 4310)).toBe(false)
  })

  test('compares a token without saying where it differs', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abd', 'abc')).toBe(false)
    expect(tokenMatches('ab', 'abc')).toBe(false)
    expect(tokenMatches(undefined, 'abc')).toBe(false)
  })
})
