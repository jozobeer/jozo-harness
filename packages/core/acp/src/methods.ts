import type { Schema } from 'effect'

/** The methods the skeleton answers. An editor drives a session through these four. */
export const ACP_METHODS = [
  'initialize',
  'session/new',
  'session/prompt',
  'session/cancel',
] as const

export type AcpMethod = (typeof ACP_METHODS)[number]

/** The methods the server sends to the editor: one notification and one request. */
export const ACP_CLIENT_METHODS = ['session/update', 'session/request_permission'] as const

export type AcpClientMethod = (typeof ACP_CLIENT_METHODS)[number]

/** The one protocol version this server speaks. */
export const ACP_PROTOCOL_VERSION = 1

export interface AgentCapabilities {
  /** Whether a prompt may carry an image; this server sends text only. */
  readonly promptCapabilities: { readonly image: false; readonly audio: false }
}

export interface InitializeParams {
  readonly protocolVersion: number
}

export interface InitializeResult {
  readonly protocolVersion: number
  readonly agentName: string
  /** What this agent can take in a prompt; absent on an older server. */
  readonly agentCapabilities?: AgentCapabilities
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

/** The stop reasons the SDK client decodes; an editor compares them by name. */
export type StopReason = 'end-turn' | 'cancelled' | 'refused'

export interface SessionPromptResult {
  readonly stopReason: StopReason
}

export interface SessionCancelParams {
  readonly sessionId: string
}

export interface SessionCancelResult {
  readonly cancelled: boolean
}

/** One permission choice the editor offers for a call that needs an answer. */
export interface PermissionOption {
  readonly optionId: string
  readonly name: string
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** What the server asks the editor: may this one call run? */
export interface RequestPermissionParams {
  readonly sessionId: string
  readonly toolCall: {
    readonly toolCallId: string
    /** The one line an editor shows on the card. */
    readonly title: string
    readonly kind: string
  }
  readonly options: ReadonlyArray<PermissionOption>
}

/** The editor's answer; a cancelled request means nobody decided. */
export type RequestPermissionResult =
  | { readonly outcome: { readonly outcome: 'selected'; readonly optionId: string } }
  | { readonly outcome: { readonly outcome: 'cancelled' } }

/** One text fragment of the assistant message for this turn. */
export interface AgentMessageChunk {
  readonly sessionUpdate: 'agent_message_chunk'
  readonly content: { readonly type: 'text'; readonly text: string }
}

/** How far one tool call has got, as an editor draws its card. */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/**
 * A tool call the agent started. jzh carries its tool name in `kind`, the same
 * field a permission card already fills with the tool, so an editor needs no
 * second naming convention.
 */
export interface ToolCallStart {
  readonly sessionUpdate: 'tool_call'
  readonly toolCallId: string
  /** The one line an editor shows for the call. */
  readonly title: string
  readonly kind: string
  readonly status: ToolCallStatus
  /** The arguments the model sent, parsed when they were JSON. */
  readonly rawInput?: unknown
}

/** One text block of a tool's output. */
export interface ToolCallContent {
  readonly type: 'text'
  readonly text: string
}

/** What became of a tool call; the output is the text the tool returned. */
export interface ToolCallUpdate {
  readonly sessionUpdate: 'tool_call_update'
  readonly toolCallId: string
  readonly status: ToolCallStatus
  readonly content?: ReadonlyArray<ToolCallContent>
}

/** Every update a session sends to an editor. */
export type SessionUpdate = AgentMessageChunk | ToolCallStart | ToolCallUpdate

export interface SessionUpdateParams {
  readonly sessionId: string
  readonly update: SessionUpdate
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
  /** A handler may wait: a turn answers when the loop is done with it. */
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
