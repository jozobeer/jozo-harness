import { Schema } from 'effect'
import type { Readable, Writable } from 'node:stream'
import type {
  AcpMethod,
  InitializeResult,
  JsonRpcError,
  JsonRpcRequest,
  SessionNewResult,
  SessionPromptResult,
} from '@jozo-harness/acp'

/** The protocol version this client sends; the server answers with its own. */
const PROTOCOL_VERSION = 1

/** The child process surface the client needs, so a test can inject plain streams. */
export interface HarnessChild {
  readonly stdin: Writable
  readonly stdout: Readable
  kill(): void
}

export interface HarnessClientOptions {
  /** Creates the child. The caller owns the command; the client owns the pipes. */
  readonly spawn: () => HarnessChild
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

const InitializeResultSchema = Schema.Struct({
  protocolVersion: Schema.Int,
  agentName: Schema.String,
})

const SessionNewResultSchema = Schema.Struct({ sessionId: Schema.String })

const SessionPromptResultSchema = Schema.Struct({
  stopReason: Schema.Union([
    Schema.Literal('end-turn'),
    Schema.Literal('cancelled'),
    Schema.Literal('refused'),
  ]),
})

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

/**
 * Speaks JSON-RPC 2.0 to a harness child process over its stdio. The transport
 * is one line per message; responses are matched to requests by id.
 */
export class HarnessClient {
  readonly #child: HarnessChild
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #buffer = ''

  constructor(options: HarnessClientOptions) {
    this.#child = options.spawn()
    this.#child.stdout.on('data', (chunk: unknown) => {
      this.#receive(String(chunk))
    })
  }

  initialize(): Promise<InitializeResult> {
    return this.#request('initialize', { protocolVersion: PROTOCOL_VERSION }, (value) =>
      Schema.decodeUnknownSync(InitializeResultSchema)(value),
    )
  }

  newSession(cwd: string): Promise<SessionNewResult> {
    return this.#request('session/new', { cwd }, (value) =>
      Schema.decodeUnknownSync(SessionNewResultSchema)(value),
    )
  }

  prompt(sessionId: string, text: string): Promise<SessionPromptResult> {
    return this.#request('session/prompt', { sessionId, prompt: [text] }, (value) =>
      Schema.decodeUnknownSync(SessionPromptResultSchema)(value),
    )
  }

  /** Ends the child and fails whatever was still waiting for an answer. */
  close(): void {
    const error = new Error('HarnessClient is closed')
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.#child.kill()
  }

  #request<Result>(
    method: AcpMethod,
    params: unknown,
    decode: (value: unknown) => Result,
  ): Promise<Result> {
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
      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
      this.#child.stdin.write(`${JSON.stringify(request)}\n`)
    })
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
    const id = parsed['id']
    // A notification has no id, and an id this client never sent is not ours to answer.
    if (typeof id !== 'number') return
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    if ('error' in parsed) {
      pending.reject(asError(parsed['error']))
      return
    }
    pending.resolve(parsed['result'])
  }
}
