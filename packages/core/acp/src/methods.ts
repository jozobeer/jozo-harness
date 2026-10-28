import type { Schema } from 'effect'

/** The methods the skeleton answers. An editor drives a session through these four. */
export const ACP_METHODS = [
  'initialize',
  'session/new',
  'session/prompt',
  'session/cancel',
] as const

export type AcpMethod = (typeof ACP_METHODS)[number]

export interface InitializeParams {
  readonly protocolVersion: number
}

export interface InitializeResult {
  readonly protocolVersion: number
  readonly agentName: string
}

export interface SessionNewParams {
  readonly cwd: string
}

export interface SessionNewResult {
  readonly sessionId: string
}

export interface SessionPromptParams {
  readonly sessionId: string
  readonly prompt: readonly string[]
}

export interface SessionPromptResult {
  readonly stopReason: 'end-turn' | 'cancelled' | 'refused'
}

export interface SessionCancelParams {
  readonly sessionId: string
}

export interface SessionCancelResult {
  readonly cancelled: boolean
}

/** What each method takes and returns; the dispatcher itself only sees unknown values. */
export interface AcpMethodTypes {
  initialize: { params: InitializeParams; result: InitializeResult }
  'session/new': { params: SessionNewParams; result: SessionNewResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/cancel': { params: SessionCancelParams; result: SessionCancelResult }
}

export interface AcpHandlerRegistration {
  /** Decoded before the handler runs, so a bad argument answers -32602 rather than reaching it. */
  readonly params?: Schema.ConstraintDecoder<unknown>
  readonly handle: (params: unknown) => unknown
}

/**
 * The handlers an embedder injects. Lookup takes a plain string because a peer
 * may name a method this server does not answer.
 */
export interface AcpHandlerRegistry {
  register(method: AcpMethod, registration: AcpHandlerRegistration): void
  get(method: string): AcpHandlerRegistration | undefined
}

export const makeAcpHandlerRegistry = (): AcpHandlerRegistry => {
  const registrations = new Map<string, AcpHandlerRegistration>()
  return {
    register: (method, registration) => {
      registrations.set(method, registration)
    },
    get: (method) => registrations.get(method),
  }
}
