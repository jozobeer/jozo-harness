import { Deferred, Effect, Stream } from 'effect'
import type { Scope } from 'effect'
import type { UiHost } from '@jozo-harness/ui-host'
import type { UiEvent } from '@jozo-harness/ui-protocol'
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type AcpSessionHost,
  type AcpSessionPort,
  type PermissionOption,
  type RequestPermissionParams,
  type SessionPromptResult,
} from '@jozo-harness/acp'

/** One core an editor drives: the session id the log names and the UI face that runs it. */
export interface AcpSessionSourceSession {
  readonly id: string
  readonly host: UiHost
}

/** Builds a session in cwd; the caller's scope owns everything it starts. */
export interface AcpSessionSource {
  readonly open: (cwd: string) => Effect.Effect<AcpSessionSourceSession, Error, Scope.Scope>
}

export interface AcpSessionPortOptions {
  /** How long an editor may sit on a permission card before it counts as refused. */
  readonly permissionTimeoutMs?: number
}

/**
 * The two choices every permission card offers. ACP names the kind so an editor
 * can draw "allow" and "refuse" without reading English.
 */
export const PERMISSION_OPTIONS: ReadonlyArray<PermissionOption> = [
  { optionId: 'allow-once', name: 'Allow this call', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Refuse this call', kind: 'reject_once' },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** True only for the allow choice; a cancelled or malformed answer refuses. */
export const approvedOf = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  const outcome = value['outcome']
  if (!isRecord(outcome) || outcome['outcome'] !== 'selected') return false
  const optionId = outcome['optionId']
  return typeof optionId === 'string' && optionId === 'allow-once'
}

/** One content block's text, or undefined for a tool call or a malformed block. */
const blockText = (block: unknown): string | undefined => {
  if (!isRecord(block) || block['type'] !== 'text') return undefined
  return typeof block['text'] === 'string' ? block['text'] : undefined
}

/** The text a settled assistant message carries, or undefined for a tool-only turn. */
const textOf = (data: unknown): string | undefined => {
  if (!isRecord(data) || !Array.isArray(data['content'])) return undefined
  const parts = data['content'].flatMap((block) => {
    const text = blockText(block)
    return text === undefined ? [] : [text]
  })
  return parts.length === 0 ? undefined : parts.join('')
}

/** The text a tool returned, joined from its text blocks. */
const toolTextOf = (content: unknown): string => {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => blockText(block) ?? []).join('')
}

/** The arguments as the model sent them, parsed when they were JSON. */
const parsedArguments = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Turns the UI host of one core into the ACP session an editor drives. The
 * host already owns the wait for an approval; this adapter carries that wait to
 * the editor as a permission request and settles it with the answer or a refusal
 * when the editor stays silent.
 */
export const acpSessionPortOf = (
  source: AcpSessionSource,
  options: AcpSessionPortOptions = {},
): AcpSessionPort => ({
  open: (cwd, client) =>
    Effect.gen(function* () {
      const session = yield* source.open(cwd)
      const permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
      let turn: Deferred.Deferred<SessionPromptResult> | undefined
      let turnStarted = false
      let cancelled = false

      const settle = (result: SessionPromptResult): Effect.Effect<void> =>
        Effect.gen(function* () {
          const waiting = turn
          if (waiting === undefined) return
          turn = undefined
          turnStarted = false
          yield* Deferred.succeed(waiting, result)
        })

      /** One permission card: the loop waits on the host map while the editor decides. */
      const askPermission = (callId: string, tool: string, reason: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const params: RequestPermissionParams = {
            sessionId: session.id,
            toolCall: { toolCallId: callId, title: reason === '' ? tool : reason, kind: tool },
            options: PERMISSION_OPTIONS,
          }
          const answer = yield* client
            .request('session/request_permission', params, { timeoutMs: permissionTimeoutMs })
            .pipe(
              // A silent editor is a refusal: the call never reaches the tool.
              Effect.catchTag('AcpTimeout', () => Effect.succeed<unknown>(undefined)),
              Effect.catchTag('AcpRequestFailed', () => Effect.succeed<unknown>(undefined)),
            )
          yield* session.host.approve(callId, approvedOf(answer))
        })

      /** Whether the prompt that is waiting also owns the turn being reported. */
      const ownsTurn = (): boolean => turn !== undefined && turnStarted

      const forwardAssistantText = (data: unknown): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!ownsTurn()) return
          const text = textOf(data)
          if (text === undefined) return
          yield* client.notify('session/update', {
            sessionId: session.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          })
        })

      const askForApproval = (data: unknown): Effect.Effect<void> => {
        if (!isRecord(data)) return Effect.void
        const callId = data['callId']
        const tool = data['tool']
        const reason = data['reason']
        if (typeof callId !== 'string' || typeof tool !== 'string') return Effect.void
        return askPermission(callId, tool, typeof reason === 'string' ? reason : '')
      }

      const forwardToolCall = (data: unknown): Effect.Effect<void> => {
        if (!ownsTurn() || !isRecord(data)) return Effect.void
        const callId = data['callId']
        const name = data['name']
        if (typeof callId !== 'string' || typeof name !== 'string') return Effect.void
        const summary = data['summary']
        return client.notify('session/update', {
          sessionId: session.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: callId,
            title: typeof summary === 'string' && summary !== '' ? summary : name,
            kind: name,
            status: 'pending',
            rawInput: parsedArguments(data['arguments']),
          },
        })
      }

      const forwardToolResult = (data: unknown): Effect.Effect<void> => {
        if (!ownsTurn() || !isRecord(data)) return Effect.void
        const callId = data['callId']
        if (typeof callId !== 'string') return Effect.void
        const text = toolTextOf(data['content'])
        return client.notify('session/update', {
          sessionId: session.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: data['isError'] === true ? 'failed' : 'completed',
            ...(text === '' ? {} : { content: [{ type: 'text' as const, text }] }),
          },
        })
      }

      // A type this adapter does not draw on is simply not forwarded.
      const turnHandlers: Readonly<Record<string, (data: unknown) => Effect.Effect<void>>> = {
        'turn/start': () => {
          if (turn !== undefined) turnStarted = true
          return Effect.void
        },
        'turn/end': () =>
          ownsTurn() ? settle({ stopReason: cancelled ? 'cancelled' : 'end-turn' }) : Effect.void,
        'assistant/message': forwardAssistantText,
        'tool/call': forwardToolCall,
        'tool/result': forwardToolResult,
        'safety/approval/requested': askForApproval,
      }

      const onTurnEvent = (type: string, data: unknown): Effect.Effect<void> =>
        turnHandlers[type]?.(data) ?? Effect.void

      const onEvent = (event: UiEvent): Effect.Effect<void> =>
        event.kind === 'session' ? onTurnEvent(event.event.type, event.event.data) : Effect.void

      yield* Stream.runForEach(session.host.events, onEvent).pipe(Effect.forkScoped)

      const host: AcpSessionHost = {
        id: session.id,
        prompt: (text) =>
          Effect.gen(function* () {
            const waiting = yield* Deferred.make<SessionPromptResult>()
            turn = waiting
            turnStarted = false
            cancelled = false
            yield* session.host.submit(text)
            return yield* Deferred.await(waiting)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                turn = undefined
                turnStarted = false
              }),
            ),
          ),
        cancel: () =>
          Effect.sync(() => {
            cancelled = true
          }).pipe(Effect.flatMap(() => session.host.cancel())),
        close: () => session.host.cancel(),
      }
      return host
    }),
})
