import { Schema } from 'effect'
import type { Readable } from 'node:stream'
import {
  JSON_RPC_ERROR,
  type AcpClientMethod,
  type AcpMethod,
  type InitializeResult,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionCancelResult,
  type SessionNewResult,
  type SessionUpdate,
  type SessionUpdateParams,
  type StopReason,
} from '@jozo-harness/acp'

/** The protocol version this client sends; the server answers with its own. */
const PROTOCOL_VERSION = 1

/**
 * The request names this SDK speaks. Callers pass the methods around rather
 * than typing their strings again, and the test of the package's public face
 * fails if one is renamed on either side.
 */
export const HARNESS_METHODS = {
  initialize: 'initialize',
  newSession: 'session/new',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
} as const satisfies Record<string, AcpMethod>

export type HarnessMethodName = (typeof HARNESS_METHODS)[keyof typeof HARNESS_METHODS]

/** The messages the server sends to this client. */
export const HARNESS_NOTIFICATIONS = {
  update: 'session/update',
  requestPermission: 'session/request_permission',
} as const satisfies Record<string, AcpClientMethod>

export type HarnessNotificationName =
  (typeof HARNESS_NOTIFICATIONS)[keyof typeof HARNESS_NOTIFICATIONS]

/** The child process surface the client needs, so a test can inject plain streams. */
export interface HarnessChild {
  readonly stdin: {
    write(text: string): void
    end(): void
  }
  readonly stdout: Readable
  /** The process id, when the spawner knows it; tests use it to prove the child is gone. */
  readonly pid?: number
  /** Resolves when the process leaves, which close waits for. */
  readonly exited: Promise<unknown>
  kill(): void
}

/** How far one tool call has got. */
export type HarnessToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** One tool call this turn made and what it returned. */
export interface HarnessToolCall {
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
  readonly status: HarnessToolStatus
  readonly failed: boolean
  /** The text the tool returned; absent while the call is still pending. */
  readonly output?: string
}

/** What one prompt settled to: the editor's stop reason, the text, and the tools. */
export interface HarnessTurn {
  readonly stopReason: StopReason
  readonly text: string
  readonly toolCalls: ReadonlyArray<HarnessToolCall>
}

export interface HarnessClientOptions {
  /** Creates the child. The caller owns the command; the client owns the pipes. */
  readonly spawn: () => HarnessChild
  /**
   * Answers a permission request. A missing handler, a rejected answer, or a
   * malformed request refuses: the client never guesses that a call may run.
   */
  readonly answerPermission?: (
    request: RequestPermissionParams,
  ) => RequestPermissionResult | Promise<RequestPermissionResult>
  /** Observes each session update as it arrives, including ones for a prompt not awaited here. */
  readonly onUpdate?: (update: SessionUpdateParams) => void
}

/** An error answer from the peer, kept as an Error so callers can catch it. */
export class HarnessResponseError extends Error {
  readonly code: number | undefined
  readonly data: unknown

  constructor(error: JsonRpcError) {
    super(error.message)
    this.name = 'HarnessResponseError'
    this.code = error.code
    this.data = error.data
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(reason: Error): void
}

interface ToolCallBuffer {
  toolCallId: string
  name: string
  input: unknown
  status: HarnessToolStatus
  failed: boolean
  output: string | undefined
}

interface TurnBuffer {
  text: string
  readonly calls: Map<string, ToolCallBuffer>
}

const InitializeResultSchema = Schema.Struct({
  protocolVersion: Schema.Int,
  agentName: Schema.String,
})

const SessionNewResultSchema = Schema.Struct({ sessionId: Schema.String })

const SessionPromptResultSchema = Schema.Struct({
  stopReason: Schema.Literals(['end-turn', 'cancelled', 'refused']),
})

const SessionCancelResultSchema = Schema.Struct({ cancelled: Schema.Boolean })

const ToolCallStatusSchema = Schema.Literals(['pending', 'in_progress', 'completed', 'failed'])

const AgentMessageChunkSchema = Schema.Struct({
  sessionUpdate: Schema.Literal('agent_message_chunk'),
  content: Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
})

const ToolCallSchema = Schema.Struct({
  sessionUpdate: Schema.Literal('tool_call'),
  toolCallId: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  status: ToolCallStatusSchema,
  rawInput: Schema.optionalKey(Schema.Unknown),
})

const ToolCallUpdateSchema = Schema.Struct({
  sessionUpdate: Schema.Literal('tool_call_update'),
  toolCallId: Schema.String,
  status: ToolCallStatusSchema,
  content: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
  ),
})

const SessionUpdateSchema = Schema.Union([
  AgentMessageChunkSchema,
  ToolCallSchema,
  ToolCallUpdateSchema,
])

const SessionUpdateParamsSchema = Schema.Struct({
  sessionId: Schema.String,
  update: SessionUpdateSchema,
})

const RequestPermissionParamsSchema = Schema.Struct({
  sessionId: Schema.String,
  toolCall: Schema.Struct({
    toolCallId: Schema.String,
    title: Schema.String,
    kind: Schema.String,
  }),
  options: Schema.Array(
    Schema.Struct({
      optionId: Schema.String,
      name: Schema.String,
      kind: Schema.Literals(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
    }),
  ),
})

const REFUSED: RequestPermissionResult = { outcome: { outcome: 'cancelled' } }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asError = (value: unknown): Error => {
  if (!isRecord(value) || typeof value['message'] !== 'string') {
    return new Error('JSON-RPC error')
  }
  return new HarnessResponseError({
    code: typeof value['code'] === 'number' ? value['code'] : 0,
    message: value['message'],
    data: value['data'],
  })
}

const decodeOrUndefined = <A>(
  schema: Schema.Schema<A> & Schema.ConstraintDecoder<unknown>,
  value: unknown,
): A | undefined => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    return undefined
  }
}

const toolCallOf = (call: ToolCallBuffer): HarnessToolCall => ({
  toolCallId: call.toolCallId,
  name: call.name,
  input: call.input,
  status: call.status,
  failed: call.failed,
  ...(call.output === undefined ? {} : { output: call.output }),
})

/** Folds one update into the turn that is waiting for an answer. */
const applyUpdate = (turn: TurnBuffer, update: SessionUpdate): void => {
  if (update.sessionUpdate === 'agent_message_chunk') {
    turn.text += update.content.text
    return
  }
  if (update.sessionUpdate === 'tool_call') {
    turn.calls.set(update.toolCallId, {
      toolCallId: update.toolCallId,
      name: update.kind,
      input: update.rawInput,
      status: update.status,
      failed: update.status === 'failed',
      output: undefined,
    })
    return
  }
  const call = turn.calls.get(update.toolCallId)
  if (call === undefined) return
  call.status = update.status
  call.failed = update.status === 'failed'
  const text = (update.content ?? []).map((block) => block.text).join('')
  if (text !== '') call.output = text
}

/**
 * Speaks JSON-RPC 2.0 to a harness child process over its stdio. The transport
 * is one line per message; responses are matched to requests by id. A prompt
 * collects the session updates that arrive before its answer, so one awaited
 * call yields the turn's text and tool results.
 */
export class HarnessClient {
  readonly #child: HarnessChild
  readonly #pending = new Map<number, Pending>()
  readonly #turns = new Map<string, TurnBuffer>()
  readonly #options: HarnessClientOptions
  #nextId = 1
  #buffer = ''
  #closed = false

  constructor(options: HarnessClientOptions) {
    this.#options = options
    this.#child = options.spawn()
    this.#child.stdout.on('data', (chunk: unknown) => {
      this.#receive(String(chunk))
    })
    // A dead child fails the calls that were waiting on it; without this a
    // caller of a crashed server would wait forever.
    this.#child.stdout.on('error', () => {
      this.#failPending(new Error('Harness stdout failed'))
    })
    this.#child.exited.then(
      () => this.#failPending(new Error('Harness process exited')),
      () => this.#failPending(new Error('Harness process exited')),
    )
  }

  initialize(): Promise<InitializeResult> {
    return this.#request(
      HARNESS_METHODS.initialize,
      { protocolVersion: PROTOCOL_VERSION },
      (value) => Schema.decodeUnknownSync(InitializeResultSchema)(value),
    )
  }

  newSession(cwd: string): Promise<SessionNewResult> {
    return this.#request(HARNESS_METHODS.newSession, { cwd }, (value) =>
      Schema.decodeUnknownSync(SessionNewResultSchema)(value),
    )
  }

  /**
   * Runs one turn and answers with its text and tools. The updates arrive as
   * `session/update` notifications while the request is still open; they are
   * folded here so a caller that only wants the settled turn does not need to
   * subscribe.
   */
  prompt(sessionId: string, text: string): Promise<HarnessTurn> {
    const turn: TurnBuffer = { text: '', calls: new Map() }
    this.#turns.set(sessionId, turn)
    return this.#request(HARNESS_METHODS.prompt, { sessionId, prompt: [text] }, (value) => {
      const result = Schema.decodeUnknownSync(SessionPromptResultSchema)(value)
      return {
        stopReason: result.stopReason,
        text: turn.text,
        toolCalls: [...turn.calls.values()].map(toolCallOf),
      }
    }).finally(() => {
      if (this.#turns.get(sessionId) === turn) this.#turns.delete(sessionId)
    })
  }

  cancel(sessionId: string): Promise<SessionCancelResult> {
    return this.#request(HARNESS_METHODS.cancel, { sessionId }, (value) =>
      Schema.decodeUnknownSync(SessionCancelResultSchema)(value),
    )
  }

  /**
   * Stops the child and waits for it to leave. Pending requests fail at once so
   * nobody waits on a process that is going away; awaiting the exit is what
   * makes a caller's cleanup complete before it returns.
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      this.#failPending(new Error('HarnessClient is closed'))
      this.#child.stdin.end()
      this.#child.kill()
    }
    await this.#child.exited.catch(() => undefined)
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.#turns.clear()
  }

  #request<Result>(
    method: HarnessMethodName,
    params: unknown,
    decode: (value: unknown) => Result,
  ): Promise<Result> {
    if (this.#closed) return Promise.reject(new Error('HarnessClient is closed'))
    return new Promise<Result>((resolve, reject) => {
      const id = this.#nextId
      this.#nextId += 1
      this.#pending.set(id, {
        resolve: (value) => {
          try {
            resolve(decode(value))
          } catch (cause) {
            reject(new Error('Unexpected result from the peer', { cause }))
          }
        },
        reject,
      })
      this.#write({ jsonrpc: '2.0', id, method, params } satisfies JsonRpcRequest)
    })
  }

  #write(message: unknown): void {
    if (this.#closed) return
    this.#child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #respond(id: JsonRpcId, result: unknown): void {
    this.#write({ jsonrpc: '2.0', id, result })
  }

  #receive(chunk: string): void {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line !== '') this.#handleLine(line)
      newline = this.#buffer.indexOf('\n')
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    const method = parsed['method']
    if (typeof method === 'string') {
      this.#handleCall(parsed['id'], method, parsed['params'])
      return
    }
    const id = parsed['id']
    if (typeof id === 'number') this.#settle(id, parsed)
  }

  #handleCall(id: unknown, method: string, params: unknown): void {
    if (id === undefined) this.#handleNotification(method, params)
    else this.#handleRequest(id, method, params)
  }

  #settle(id: number, message: Record<string, unknown>): void {
    const pending = this.#pending.get(id)
    // A response this client never asked for is not ours to settle.
    if (pending === undefined) return
    this.#pending.delete(id)
    if ('error' in message) {
      pending.reject(asError(message['error']))
      return
    }
    pending.resolve(message['result'])
  }

  #handleNotification(method: string, params: unknown): void {
    if (method !== HARNESS_NOTIFICATIONS.update) return
    const update = decodeOrUndefined(SessionUpdateParamsSchema, params)
    if (update === undefined) return
    this.#options.onUpdate?.(update)
    const turn = this.#turns.get(update.sessionId)
    if (turn !== undefined) applyUpdate(turn, update.update)
  }

  #handleRequest(id: unknown, method: string, params: unknown): void {
    if (method !== HARNESS_NOTIFICATIONS.requestPermission) {
      this.#write({
        jsonrpc: '2.0',
        id,
        error: { code: JSON_RPC_ERROR.methodNotFound, message: 'Method not found' },
      })
      return
    }
    // Only a number or string id can be answered; a null id came from a malformed call.
    if (typeof id !== 'number' && typeof id !== 'string') return
    const request = decodeOrUndefined(RequestPermissionParamsSchema, params)
    if (request === undefined) {
      this.#respond(id, REFUSED)
      return
    }
    const answer = this.#options.answerPermission?.(request) ?? REFUSED
    Promise.resolve(answer).then(
      (result) => this.#respond(id, result),
      () => this.#respond(id, REFUSED),
    )
  }
}
