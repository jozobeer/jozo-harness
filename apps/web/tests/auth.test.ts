import { describe, expect, test } from 'vitest'
import {
  authCookie,
  codeExchange,
  codeFromUrl,
  cookieOf,
  hostAllowed,
  originAllowed,
  tokenFromUrl,
  tokenMatches,
} from '../src/server/auth.ts'

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

  test('reads the single-use code a startup url carries', () => {
    expect(codeFromUrl('/?code=abc')).toBe('abc')
    expect(codeFromUrl('/?session=s-1&code=abc')).toBe('abc')
    expect(codeFromUrl('/')).toBeUndefined()
    expect(codeFromUrl('/?code=')).toBeUndefined()
  })

  test('redeems a code once and only while it is fresh', () => {
    let now = 1_000
    const codes = codeExchange(() => now, 60_000)
    const fresh = codes.issue()
    expect(fresh).toMatch(/^[0-9a-f]{64}$/)
    expect(codes.redeem(fresh)).toBe(true)
    expect(codes.redeem(fresh)).toBe(false)

    const stale = codes.issue()
    now += 60_001
    expect(codes.redeem(stale)).toBe(false)
    expect(codes.redeem(undefined)).toBe(false)
  })

  test('reads one cookie by name from the header a browser repeats', () => {
    expect(cookieOf('jzh_web=abc; other=1', 'jzh_web')).toBe('abc')
    expect(cookieOf('other=1; jzh_web=abc', 'jzh_web')).toBe('abc')
    expect(cookieOf('other=1', 'jzh_web')).toBeUndefined()
    expect(cookieOf(undefined, 'jzh_web')).toBeUndefined()
  })

  test('builds a strict cookie, secure only where the page was https', () => {
    expect(authCookie('abc', false)).toBe('jzh_web=abc; Path=/; HttpOnly; SameSite=Strict')
    expect(authCookie('abc', true)).toBe('jzh_web=abc; Path=/; HttpOnly; SameSite=Strict; Secure')
  })
})
