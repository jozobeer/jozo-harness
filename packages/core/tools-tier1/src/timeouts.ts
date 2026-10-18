/**
 * The longest a tool call may wait on the network or on a child process
 * before the tool pipeline ends it. Without a declared bound a server that
 * never answers holds the whole turn. 30s matches dsh's web_fetch.
 */
export const NETWORK_TOOL_TIMEOUT_MS = 30_000
