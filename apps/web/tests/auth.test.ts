import { describe, expect, test } from 'vitest'
import {
  authCookie,
  codeExchange,
  codeFromUrl,
  cookieOf,
  hostAllowed,
  JOIN_COOKIE_NAME,
  joinCookie,
  joinFromUrl,
  originAllowed,
  participantOf,
  requestAuthorized,
  tokenFromUrl,
  tokenMatches,
} from '../src/server/auth.ts'
import { makeParticipantRegistry } from '../src/server/participants.ts'

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
    // A browser that resolves localhost to its IPv6 name still names this machine.
    expect(hostAllowed('[::1]:4310', 4310)).toBe(true)
    expect(hostAllowed('[::2]:4310', 4310)).toBe(false)
    expect(hostAllowed('127.0.0.1:4311', 4310)).toBe(false)
    expect(hostAllowed('evil.example:4310', 4310)).toBe(false)
    expect(hostAllowed(undefined, 4310)).toBe(false)
  })

  test('accepts the page origin, and a client that names no origin', () => {
    expect(originAllowed('http://127.0.0.1:4310', 4310)).toBe(true)
    expect(originAllowed('http://localhost:4310', 4310)).toBe(true)
    expect(originAllowed('http://[::1]:4310', 4310)).toBe(true)
    expect(originAllowed('http://[::1]:4311', 4310)).toBe(false)
    expect(originAllowed(undefined, 4310)).toBe(true)
    expect(originAllowed('http://evil.example', 4310)).toBe(false)
    expect(originAllowed('null', 4310)).toBe(false)
    expect(originAllowed('https://127.0.0.1:4310', 4310)).toBe(false)
  })

  test('adds only the published origin to the loopback names', () => {
    const published = {
      host: 'myhost.tailnet.ts.net',
      origin: 'https://myhost.tailnet.ts.net',
    }
    expect(hostAllowed('myhost.tailnet.ts.net', 4310, published)).toBe(true)
    expect(hostAllowed('MYHOST.TAILNET.TS.NET', 4310, published)).toBe(true)
    expect(originAllowed('https://myhost.tailnet.ts.net', 4310, published)).toBe(true)
    expect(originAllowed('HTTPS://MYHOST.TAILNET.TS.NET', 4310, published)).toBe(true)
    // The published name is https-only, and another host is never a near miss.
    expect(originAllowed('http://myhost.tailnet.ts.net', 4310, published)).toBe(false)
    expect(hostAllowed('myhost.tailnet.ts.net.evil.example', 4310, published)).toBe(false)
    expect(originAllowed('https://myhost.tailnet.ts.net.evil.example', 4310, published)).toBe(false)
    // Loopback still passes, and nothing does when no origin was published.
    expect(hostAllowed('127.0.0.1:4310', 4310, published)).toBe(true)
    expect(originAllowed(undefined, 4310, published)).toBe(true)
    expect(hostAllowed('myhost.tailnet.ts.net', 4310)).toBe(false)
    expect(originAllowed('https://myhost.tailnet.ts.net', 4310)).toBe(false)
  })

  test('adds only the detected tailnet names, at the bound port', () => {
    const tailnet = { ip: '100.88.96.60', dns: 'myhost.tailnet.ts.net' }
    expect(hostAllowed('100.88.96.60:4310', 4310, undefined, tailnet)).toBe(true)
    expect(hostAllowed('myhost.tailnet.ts.net:4310', 4310, undefined, tailnet)).toBe(true)
    expect(hostAllowed('MYHOST.TAILNET.TS.NET:4310', 4310, undefined, tailnet)).toBe(true)
    expect(originAllowed('http://100.88.96.60:4310', 4310, undefined, tailnet)).toBe(true)
    expect(originAllowed('http://myhost.tailnet.ts.net:4310', 4310, undefined, tailnet)).toBe(true)
    // The port is part of both names; https is the published origin's spelling.
    expect(hostAllowed('100.88.96.60', 4310, undefined, tailnet)).toBe(false)
    expect(hostAllowed('myhost.tailnet.ts.net', 4310, undefined, tailnet)).toBe(false)
    expect(hostAllowed('100.88.96.60:4311', 4310, undefined, tailnet)).toBe(false)
    expect(originAllowed('https://myhost.tailnet.ts.net:4310', 4310, undefined, tailnet)).toBe(
      false,
    )
    expect(originAllowed('http://myhost.tailnet.ts.net:4311', 4310, undefined, tailnet)).toBe(false)
    // Another machine in the tailnet, or the bare suffix, is never admitted.
    expect(hostAllowed('other.tailnet.ts.net:4310', 4310, undefined, tailnet)).toBe(false)
    expect(hostAllowed('100.88.96.61:4310', 4310, undefined, tailnet)).toBe(false)
    expect(hostAllowed('myhost.tailnet.ts.net.evil.example:4310', 4310, undefined, tailnet)).toBe(
      false,
    )
    // Loopback keeps its names, and no detection admits nothing.
    expect(hostAllowed('127.0.0.1:4310', 4310, undefined, tailnet)).toBe(true)
    expect(hostAllowed('100.88.96.60:4310', 4310)).toBe(false)
    expect(originAllowed('http://100.88.96.60:4310', 4310)).toBe(false)
  })

  test('admits only the tailnet address the detection named', () => {
    const ipOnly = { ip: '100.88.96.60' }
    expect(hostAllowed('100.88.96.60:4310', 4310, undefined, ipOnly)).toBe(true)
    expect(hostAllowed('myhost.tailnet.ts.net:4310', 4310, undefined, ipOnly)).toBe(false)

    const nameOnly = { dns: 'myhost.tailnet.ts.net' }
    expect(hostAllowed('myhost.tailnet.ts.net:4310', 4310, undefined, nameOnly)).toBe(true)
    expect(hostAllowed('100.88.96.60:4310', 4310, undefined, nameOnly)).toBe(false)
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

  test('reads the invitation a join link carries, under its own cookie', () => {
    expect(joinFromUrl('/?join=def')).toBe('def')
    expect(joinFromUrl('/?session=s-1&join=def')).toBe('def')
    expect(joinFromUrl('/')).toBeUndefined()
    expect(joinFromUrl('/?join=')).toBeUndefined()
    expect(joinCookie('def', false)).toBe(
      JOIN_COOKIE_NAME + '=def; Path=/; HttpOnly; SameSite=Strict',
    )
    expect(joinCookie('def', true)).toBe(
      JOIN_COOKIE_NAME + '=def; Path=/; HttpOnly; SameSite=Strict; Secure',
    )
  })

  test('admits a live invitation and refuses one the owner cut', () => {
    const participants = makeParticipantRegistry(() => 0)
    const guest = participants.issue('Alice')
    const gate = { token: 'owner', codes: codeExchange(() => 0), participants }
    const owner = 'other=1; jzh_web=owner'
    const joined = 'other=1; ' + JOIN_COOKIE_NAME + '=' + guest.token
    expect(requestAuthorized('/', owner, gate)).toBe(true)
    expect(requestAuthorized('/', joined, gate)).toBe(true)
    expect(requestAuthorized('/?join=' + guest.token, undefined, gate)).toBe(true)
    expect(requestAuthorized('/', 'jzh_join=' + 'f'.repeat(64), gate)).toBe(false)
    expect(requestAuthorized('/', undefined, gate)).toBe(false)
    expect(participantOf('/', joined, gate)?.id).toBe(guest.id)
    expect(participantOf('/', owner, gate)).toBeUndefined()

    participants.revoke(guest.id)
    expect(requestAuthorized('/', joined, gate)).toBe(false)
    expect(participantOf('/', joined, gate)).toBeUndefined()
  })
})
