/**
 * The one seam through which an adapter reaches a provider: one call is one
 * attempt, and the response body is read as it arrives. A browser page passes
 * the global `fetch`; Node passes the proxy-aware `outboundFetch`; a test passes
 * a stub. Keeping the shape of `fetch` lets every one of them stay small.
 */
export type LlmTransport = typeof fetch

/** The transport a page gets for free: the platform's own fetch. */
export const fetchTransport: LlmTransport = (input, init) => fetch(input, init)
