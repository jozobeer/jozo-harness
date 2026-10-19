import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The gate in front of the web socket. The server binds to loopback and has no
 * account to ask for, so three things stand in for one: the request must name
 * this server in Host (a rebinding page names its own), a browser's Origin must
 * be the page this server served, and the socket must repeat the token, either
 * from the HttpOnly cookie the startup code traded for or from `?token=` for
 * scripts. The ready URL carries only the one-time code, so a copied link stops
 * working once it has opened a page.
 */

/** The names a page may use to reach a server bound to loopback, at its port. */
const hostsAt = (port: number): ReadonlyArray<string> => [
  '127.0.0.1:' + String(port),
  'localhost:' + String(port),
]

/** The origins those names give a page served over http. */
const originsAt = (port: number): ReadonlyArray<string> =>
  hostsAt(port).map((host) => 'http://' + host)

/** One query parameter, where a missing or empty one reads the same. */
const queryParam = (url: string, name: string): string | undefined => {
  const value = new URL(url, 'http://127.0.0.1').searchParams.get(name)
  return value === null || value === '' ? undefined : value
}

/** The token a URL carries; a missing or empty one reads the same. */
export const tokenFromUrl = (url: string): string | undefined => queryParam(url, 'token')

/** The one-time code a startup URL carries; a missing or empty one reads the same. */
export const codeFromUrl = (url: string): string | undefined => queryParam(url, 'code')

/** The cookie a page repeats once the startup code traded it for one. */
export const COOKIE_NAME = 'jzh_web'

/** How long a startup code may be redeemed; long enough to open a copied link. */
export const CODE_TTL_MS = 60_000

/** The codes one server issues, each redeemable once and only while fresh. */
export interface CodeExchange {
  /** Mints a code for a ready URL; the URL must not carry anything longer lived. */
  readonly issue: () => string
  /** Consumes a code, answering whether it named one still worth trading. */
  readonly redeem: (code: string | undefined) => boolean
  /**
   * Answers whether a code is still worth trading, without trading it. The page
   * trades it once for a cookie; a socket may name it for as long as it lives, so
   * a script can connect with the URL the command printed and reconnect after a
   * reload without a browser to hold the cookie.
   */
  readonly peek: (code: string | undefined) => boolean
}

/**
 * Keeps only the codes this run issued, so a guessed code costs a lookup and
 * never names the token. A redeemed code is dropped even when it had expired,
 * so replay reads as no match rather than as a fresh decision.
 */
export const codeExchange = (now: () => number, ttlMs = CODE_TTL_MS): CodeExchange => {
  const live = new Map<string, number>()
  return {
    issue: () => {
      const code = randomBytes(32).toString('hex')
      live.set(code, now() + ttlMs)
      return code
    },
    redeem: (code) => {
      if (code === undefined) return false
      const expiresAt = live.get(code)
      if (expiresAt === undefined) return false
      live.delete(code)
      return expiresAt > now()
    },
    peek: (code) => {
      if (code === undefined) return false
      const expiresAt = live.get(code)
      return expiresAt !== undefined && expiresAt > now()
    },
  }
}

/** One cookie's value from the header a browser repeats, by name. */
export const cookieOf = (header: string | undefined, name: string): string | undefined => {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0 || part.slice(0, index).trim() !== name) continue
    const value = part.slice(index + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/**
 * The cookie that stands for the token. It is script-invisible and never rides
 * a cross-site request; Secure is left to a page served over https, because a
 * loopback page is http and a browser would drop a Secure cookie there.
 */
export const authCookie = (token: string, secure: boolean): string =>
  COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '')

/** True only for the loopback host and the port this server bound. */
export const hostAllowed = (host: string | undefined, port: number): boolean =>
  host !== undefined && hostsAt(port).includes(host.toLowerCase())

/**
 * True for the page's own origin and for a client that names none. A browser
 * always names one; refusing only a foreign origin keeps native clients (and
 * their tests) able to connect without pretending to be a page.
 */
export const originAllowed = (origin: string | undefined, port: number): boolean =>
  origin === undefined || originsAt(port).includes(origin.toLowerCase())

/** Compares the token in constant time, so a reply says only match or no match. */
export const tokenMatches = (given: string | undefined, expected: string): boolean => {
  if (given === undefined) return false
  const offered = Buffer.from(given)
  const wanted = Buffer.from(expected)
  return offered.length === wanted.length && timingSafeEqual(offered, wanted)
}
