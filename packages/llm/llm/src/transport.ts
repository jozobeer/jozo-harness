/**
 * The one seam through which an adapter reaches a provider: one call is one
 * attempt, and the response body is read as it arrives. A browser page passes
 * the global `fetch`; Node passes the proxy-aware `outboundFetch`; a test passes
 * a stub. Keeping the shape of `fetch` lets every one of them stay small.
 */
export type LlmTransport = typeof fetch

/** The transport a page gets for free: the platform's own fetch. */
export const fetchTransport: LlmTransport = (input, init) => fetch(input, init)

/** One link of an error's cause chain as text. */
const causeText = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  return typeof cause === 'string' ? cause : JSON.stringify(cause)
}

/** The causes under an error, outermost first; a chain that loops ends where it repeats. */
const causesOf = (failure: unknown): ReadonlyArray<unknown> => {
  const causes: Array<unknown> = []
  let cause = failure instanceof Error ? failure.cause : undefined
  while (cause !== undefined && cause !== failure && !causes.includes(cause)) {
    causes.push(cause)
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return causes
}

/**
 * A rejected transport call as one line. Node's fetch says only "fetch failed" and
 * keeps the socket error (ECONNREFUSED, ENOTFOUND, ...) in `cause`, which `String`
 * drops, so the chain's messages are appended.
 */
export const transportFailureText = (failure: unknown): string => {
  const causes = causesOf(failure).map(causeText)
  return String(failure) + (causes.length === 0 ? '' : ' (' + causes.join('; ') + ')')
}
