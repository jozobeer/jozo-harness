import { timingSafeEqual } from 'node:crypto'

/**
 * The gate in front of the web socket. The server binds to loopback and has no
 * account to ask for, so three things stand in for one: the request must name
 * this server in Host (a rebinding page names its own), a browser's Origin must
 * be the page this server served, and the socket must repeat the token printed
 * in the ready URL.
 */

/** The names a page may use to reach a server bound to loopback, at its port. */
const hostsAt = (port: number): ReadonlyArray<string> => [
  '127.0.0.1:' + String(port),
  'localhost:' + String(port),
]

/** The origins those names give a page served over http. */
const originsAt = (port: number): ReadonlyArray<string> =>
  hostsAt(port).map((host) => 'http://' + host)

/** The token a URL carries; a missing or empty one reads the same. */
export const tokenFromUrl = (url: string): string | undefined => {
  const token = new URL(url, 'http://127.0.0.1').searchParams.get('token')
  return token === null || token === '' ? undefined : token
}

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
