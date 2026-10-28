import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Participant, ParticipantRegistry } from './participants.ts'
import type { TailnetAddresses } from './tailnet.ts'

/**
 * The gate in front of the web socket. The server binds to loopback, and to
 * this machine's tailnet address when Tailscale named one, and has no account
 * to ask for, so three things stand in for one: the request must name this
 * server in Host (a rebinding page names its own), a browser's Origin must be
 * the page this server served, and the socket must repeat the token, either
 * from the HttpOnly cookie the startup code traded for or from `?token=` for
 * scripts. The ready URL carries only the one-time code, so a copied link stops
 * working once it has opened a page. An invitation token the owner issued
 * stands in for the run token while the owner keeps it live.
 */

/**
 * The https origin a reverse proxy publishes this server under, as the page's
 * own Host and Origin. It is an explicit addition to the loopback names, never
 * a pattern: a request that names any other host stays refused.
 */
export interface PublicOrigin {
  /** The Host header the proxy passes on, with a port when it is not 443. */
  readonly host: string
  /** The Origin a page served from there sends. */
  readonly origin: string
}

/**
 * The detected tailnet names at this port. Only the addresses Tailscale named
 * for this machine: a range or a suffix would admit a machine nobody checked.
 */
const tailnetAt = (port: number, tailnet: TailnetAddresses | undefined): ReadonlyArray<string> =>
  tailnet === undefined
    ? []
    : [tailnet.ip, tailnet.dns]
        .filter((address): address is string => address !== undefined)
        .map((address) => address.toLowerCase() + ':' + String(port))

/** The names a page may use to reach the server, at its port. */
const hostsAt = (
  port: number,
  publicOrigin: PublicOrigin | undefined,
  tailnet: TailnetAddresses | undefined,
): ReadonlyArray<string> => [
  '127.0.0.1:' + String(port),
  'localhost:' + String(port),
  // The listener is IPv4 loopback, but a local forwarder on the IPv6 loopback
  // names this machine too; both spellings are loopback, neither is a pattern.
  '[::1]:' + String(port),
  ...tailnetAt(port, tailnet),
  ...(publicOrigin === undefined ? [] : [publicOrigin.host.toLowerCase()]),
]

/** The origins those names give a page: http on loopback and the tailnet, https for the published one. */
const originsAt = (
  port: number,
  publicOrigin: PublicOrigin | undefined,
  tailnet: TailnetAddresses | undefined,
): ReadonlyArray<string> => [
  'http://127.0.0.1:' + String(port),
  'http://localhost:' + String(port),
  'http://[::1]:' + String(port),
  ...tailnetAt(port, tailnet).map((name) => 'http://' + name),
  ...(publicOrigin === undefined ? [] : [publicOrigin.origin.toLowerCase()]),
]

/** One query parameter, where a missing or empty one reads the same. */
const queryParam = (url: string, name: string): string | undefined => {
  const value = new URL(url, 'http://127.0.0.1').searchParams.get(name)
  return value === null || value === '' ? undefined : value
}

/** The token a URL carries; a missing or empty one reads the same. */
export const tokenFromUrl = (url: string): string | undefined => queryParam(url, 'token')

/** The one-time code a startup URL carries; a missing or empty one reads the same. */
export const codeFromUrl = (url: string): string | undefined => queryParam(url, 'code')

/** The invitation token a join link carries; a missing or empty one reads the same. */
export const joinFromUrl = (url: string): string | undefined => queryParam(url, 'join')

/** The cookie a page repeats once the startup code traded it for one. */
export const COOKIE_NAME = 'jzh_web'

/** The cookie a joined browser repeats once it traded the owner's link for one. */
export const JOIN_COOKIE_NAME = 'jzh_join'

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

/**
 * The cookie that stands for an invitation. It is a different name from the
 * owner's, so joining never replaces the owner's credential in a browser that
 * already holds one, and cutting the invitation cannot cut the owner's page.
 */
export const joinCookie = (token: string, secure: boolean): string =>
  JOIN_COOKIE_NAME +
  '=' +
  token +
  '; Path=/; HttpOnly; SameSite=Strict' +
  (secure ? '; Secure' : '')

/** True only for a loopback name, a detected tailnet name, or the published host, at this port. */
export const hostAllowed = (
  host: string | undefined,
  port: number,
  publicOrigin?: PublicOrigin,
  tailnet?: TailnetAddresses,
): boolean =>
  host !== undefined && hostsAt(port, publicOrigin, tailnet).includes(host.toLowerCase())

/**
 * True for the page's own origin and for a client that names none. A browser
 * always names one; refusing only a foreign origin keeps native clients (and
 * their tests) able to connect without pretending to be a page.
 */
export const originAllowed = (
  origin: string | undefined,
  port: number,
  publicOrigin?: PublicOrigin,
  tailnet?: TailnetAddresses,
): boolean =>
  origin === undefined || originsAt(port, publicOrigin, tailnet).includes(origin.toLowerCase())

/**
 * True when the request repeats the run's token in its cookie or its URL, or
 * still carries a startup code worth trading. The artifact list and the plugin
 * list share this gate; the page itself arrives before either.
 */
export const requestAuthorized = (
  url: string,
  cookie: string | undefined,
  gate: {
    readonly token: string
    readonly codes: CodeExchange
    readonly participants?: ParticipantRegistry
  },
): boolean =>
  tokenMatches(cookieOf(cookie, COOKIE_NAME) ?? tokenFromUrl(url), gate.token) ||
  gate.codes.peek(codeFromUrl(url)) ||
  participantOf(url, cookie, gate) !== undefined

/**
 * The invitation a request carries, or undefined for the owner, a startup code,
 * and a token the owner already cut. The socket remembers this so cutting one
 * invitation can close the sockets that joined through it and no other.
 */
export const participantOf = (
  url: string,
  cookie: string | undefined,
  gate: { readonly participants?: ParticipantRegistry },
): Participant | undefined =>
  gate.participants?.find(cookieOf(cookie, JOIN_COOKIE_NAME) ?? joinFromUrl(url))

/** The names and the credential a read route checks before it answers. */
export interface RequestGate {
  readonly port: number
  readonly publicOrigin: PublicOrigin | undefined
  readonly tailnet: TailnetAddresses | undefined
  readonly token: string
  readonly codes: CodeExchange
  /** The invitations that may read and type as the owner does; absent refuses them. */
  readonly participants?: ParticipantRegistry
}

/** What a refused read would answer: the status and the one line the page shows. */
export interface GateRefusal {
  readonly status: number
  readonly message: string
}

/**
 * Why the shared gate refuses this request, or undefined when it admits it.
 * The artifact, plugin, and session export routes all sit behind this check, so
 * a foreign origin and a request without a cookie, a code, a token, or a live
 * invitation are refused the same way before any route reads a file.
 */
export const refusedBy = (request: IncomingMessage, gate: RequestGate): GateRefusal | undefined => {
  if (!originAllowed(request.headers.origin, gate.port, gate.publicOrigin, gate.tailnet)) {
    return { status: 403, message: 'forbidden' }
  }
  if (!requestAuthorized(request.url ?? '', request.headers.cookie, gate)) {
    return { status: 401, message: 'a token or a code is required' }
  }
  return undefined
}

/** Compares the token in constant time, so a reply says only match or no match. */
export const tokenMatches = (given: string | undefined, expected: string): boolean => {
  if (given === undefined) return false
  const offered = Buffer.from(given)
  const wanted = Buffer.from(expected)
  return offered.length === wanted.length && timingSafeEqual(offered, wanted)
}
