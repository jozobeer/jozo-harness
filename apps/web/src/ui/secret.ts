/**
 * The conversation hides credentials before they reach the screen: a reader who
 * shares a window or a screenshot should not carry a live key with them. The
 * event log, the export, and the text the model receives keep the original — the
 * mask is a display rule, so it runs last, at render.
 *
 * There is no reveal control. A value that can be revealed is still in the DOM,
 * and one click later it is on a slide; the log holds the exact text for anyone
 * who needs to check it, so the screen can stay safe by default.
 */

/** A secret keeps the shape that named it and its last four characters, so a reader can tell one from another. */
const hidden = (shape: string, value: string): string => shape + '…' + value.slice(-4)

/**
 * An assignment such as `GITHUB_TOKEN=…` or `API_KEY: …`. The name must end in
 * the word that makes it a secret, so `MAX_KEY_LENGTH=100` stays as written.
 */
const ASSIGNED =
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*)(["']?)([^\s"']{4,})\2/g

/** A credentialed request keeps the scheme and hides the token that follows it. */
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g

/** A vendor token keeps its own prefix: `sk-…abcd` reads as an OpenAI key at a glance. */
const PREFIXED =
  /\b(sk-|rk-|pk-|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)([A-Za-z0-9_-]{12,})/g

/** A signed token is three base64url parts; the dots keep the shape recognisable. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g

/** An armored key hides whole, armor included; its tail would only show dashes. */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/** A long base64 or hex run is a blob; a word this long with a digit in it is a secret, not prose. */
const BLOB = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g

const looksRandom = (value: string): boolean => /[0-9]/.test(value) && /[A-Za-z]/.test(value)

/**
 * The one place that decides what a secret looks like. It returns the text a
 * reader sees; a message that names no secret comes back exactly as it went in.
 */
export const maskSecrets = (text: string): string =>
  text
    .replace(PRIVATE_KEY, '-----BEGIN PRIVATE KEY-----…-----END PRIVATE KEY-----')
    .replace(ASSIGNED, (_match: string, name: string, _quote: string, value: string) =>
      hidden(name, value),
    )
    .replace(BEARER, (_match: string, scheme: string, token: string) => hidden(scheme, token))
    .replace(PREFIXED, (_match: string, prefix: string, token: string) => hidden(prefix, token))
    .replace(JWT, (match: string) => hidden('', match))
    .replace(BLOB, (match: string) => (looksRandom(match) ? hidden('', match) : match))
