import type { Emit } from '@jozo-harness/kernel'
import type { FileDiff, ToolErrorInfo } from '@jozo-harness/tools'
import type {
  AssistantStreamRecord,
  ContentBlock,
  LlmFailureCode,
  LlmFailureData,
  LlmUsage,
  ToolSchema,
} from '@jozo-harness/llm'
import type { Session } from './session.ts'

export type SessionSeq = number
export type SessionId = string

export const SESSION_FORMAT_VERSION = 1

/** The first event of every log. */
export interface SessionHeader {
  readonly formatVersion: number
  readonly createdAt: number
  readonly cwd: string
}

export type TurnCancelCause = 'user' | 'shutdown' | 'parent-cancelled'

/** Reasons a turn can end. Plugins add their own by declaration merging. */
export interface TurnEndReasonMap {
  completed: { readonly kind: 'completed' }
  cancelled: { readonly kind: 'cancelled'; readonly cause: TurnCancelCause }
  error: { readonly kind: 'error'; readonly failure: LlmFailureData }
  /** The provider stopped at the output cap before the answer settled. */
  'max-tokens': { readonly kind: 'max-tokens' }
  /** The run died inside the turn; the next run closed it without an answer. */
  interrupted: { readonly kind: 'interrupted' }
}

export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

/**
 * Why a user message entered the log. The schema derives its literals from this
 * list, so an added source cannot be forgotten on the way to the log.
 */
export const USER_MESSAGE_SOURCES = [
  'user',
  'inject',
  'runtime-context',
  'skill-catalog',
  'goal-round',
  'schedule',
] as const

export type UserMessageSource = (typeof USER_MESSAGE_SOURCES)[number]

export interface AssistantMessageData {
  readonly provider: string
  readonly model: string
  readonly content: ReadonlyArray<ContentBlock>
  readonly usage?: LlmUsage
  readonly replayState?: unknown
  readonly stream: ReadonlyArray<AssistantStreamRecord>
}

/** An attempt that did not become history. */
export interface AssistantAttemptData {
  readonly provider: string
  readonly model: string
  readonly failure: LlmFailureData
  readonly stream: ReadonlyArray<AssistantStreamRecord>
}

/** Why a failed attempt was sent again. */
export type RetryCause = 'transient' | 'context-overflow'

/** One recovery step between two provider attempts: what failed and how long it waits. */
export interface LlmRetryData {
  /** The attempt that failed, 1-based. */
  readonly attempt: number
  readonly code: LlmFailureCode
  /** The wait before the next attempt, in milliseconds. */
  readonly delayMs: number
  readonly cause: RetryCause
  /**
   * Pairs this decision with the `llm/retry-started` written once the wait is
   * over. Logs from before the field keep decoding; a retry without a matching
   * start is one that was cut short.
   */
  readonly retryId?: string
}

/** The wait is over: the retry paired with this id is about to be sent. */
export interface LlmRetryStartedData {
  readonly retryId: string
}

/** Every event the S1 kernel and its packages log. Plugins extend this interface. */
/** A log that lost its torn tail when it was opened: how much was dropped. */
export interface SessionRepaired {
  readonly tornBytes: number
}

export interface SessionEventMap {
  'session/header': SessionHeader
  'session/cwd/changed': CwdChanged
  'session/repaired': SessionRepaired
  'compaction/prune': CompactionPrune
  'compaction/checkpoint': CompactionCheckpoint
  'turn/start': { readonly turn: number }
  'turn/end': { readonly turn: number; readonly reason: TurnEndReason }
  'step/start': { readonly step: number }
  'step/end': { readonly step: number }
  'request/header': RequestHeaderData
  /** The settled system prompt; sections names the parts that rendered into it. */
  'system/message': { readonly text: string; readonly sections?: ReadonlyArray<string> }
  'user/message': { readonly text: string; readonly source: UserMessageSource }
  'assistant/message': AssistantMessageData
  'assistant/attempt': AssistantAttemptData
  'llm/retry': LlmRetryData
  'llm/retry-started': LlmRetryStartedData
  'tool/call': {
    readonly callId: string
    readonly name: string
    readonly arguments: string
    /** The one line a UI shows for the call, rendered by the pipeline. */
    readonly summary?: string
  }
  'tool/result': {
    readonly callId: string
    readonly isError: boolean
    readonly content: ReadonlyArray<ContentBlock>
    /** The one line a UI shows for the result, rendered by the pipeline. */
    readonly summary?: string
    /**
     * The file changes the call made, computed while it ran. Log-only: the
     * model history is built from `content` alone, so a diff never reaches the
     * prompt.
     */
    readonly diffs?: ReadonlyArray<FileDiff>
    /**
     * Why the call failed, as a code rather than only text. Log-only for the
     * same reason as `diffs`: the model history reads `content` alone. Absent
     * when the call never finished, since an unknown outcome is not a failure.
     */
    readonly error?: ToolErrorInfo
    /**
     * The call ended the turn it ran in. The model history ignores it; the loop
     * reads it to close the turn without another request.
     */
    readonly concludesTurn?: true
  }
  'job/started': JobStartedData
  'job/ended': JobEndedData
}

/** A background job this run registered, recorded when it started. */
export interface JobStartedData {
  readonly id: string
  readonly command: string
  readonly startedAt: number
  /** The directory the command runs in; a promoted child keeps the one it was spawned with. */
  readonly cwd?: string
}

/** A job that stopped, so a resumed run can tell a finished job from one it never knew. */
export interface JobEndedData {
  readonly id: string
  readonly endedAt: number
  /** Whether the command exited on its own or a caller stopped it. */
  readonly status: 'exited' | 'killed'
  /** The exit code of a command that exited; a killed one has none. */
  readonly exitCode?: number
}

export type SessionEventType = keyof SessionEventMap

/** One append-only log record. `type` discriminates so `ev.data` narrows without a cast. */
export type SessionEvent = {
  readonly [K in SessionEventType]: {
    readonly seq: SessionSeq
    readonly time: number
    readonly type: K
    readonly data: SessionEventMap[K]
    readonly ignorable?: true
  }
}[SessionEventType]

declare module '@jozo-harness/kernel/hook' {
  interface HookMap {
    'session/event': Emit<(event: SessionEvent, session: Session) => void>
  }
}

/** The working directory moved. The newest one wins. */
export interface CwdChanged {
  readonly cwd: string
  /** The workspace root this move also establishes, when it moved to another tree. */
  readonly root?: string
}

/** Why a request header was written instead of reusing the one before it. */
export type RequestHeaderReason =
  /** The first header of the session. */
  | 'opened'
  /** The route, the parameters, or the tools differ from the last header. */
  | 'changed'

/**
 * What a request was assembled with. It is written once per request series: the
 * assembled tools and parameters are part of the log, so a request can be
 * reconstructed from the log alone, not only from the provider's answer.
 */
export interface RequestHeaderData {
  readonly provider: string
  readonly model: string
  readonly params: Readonly<Record<string, unknown>>
  /** Every tool the model could call, as the provider received it. */
  readonly tools: ReadonlyArray<ToolSchema>
  /** 1-based; a new series starts whenever the assembled request differs. */
  readonly series: number
  readonly reason: RequestHeaderReason
}

/** The content one request carries in place of a shadowed event's own content. */
export interface CompactReplacement {
  readonly seq: SessionSeq
  readonly content: ReadonlyArray<ContentBlock>
}

/**
 * An auxiliary model condensed this span of the history into one summary. The
 * events stay in the log untouched, so the replaced span is traceable; the fold
 * carries the summary in their place.
 */
export interface CompactionCheckpoint {
  /** The events whose messages the summary stands for, oldest first. */
  readonly shadowedSeqs: ReadonlyArray<SessionSeq>
  readonly shadowedRange: { readonly start: SessionSeq; readonly end: SessionSeq }
  readonly summary: string
  readonly provider: string
  readonly model: string
}

/**
 * The request stops carrying the content of these events and carries their
 * replacements instead. Log-only: no surface change, and the shadowed events keep
 * their own content, so the request is what the log says it was.
 */
export interface CompactionPrune {
  /** The events whose message content the request replaces, oldest first. */
  readonly shadowedSeqs: ReadonlyArray<SessionSeq>
  /** First and last of those seqs. */
  readonly shadowedRange: { readonly start: SessionSeq; readonly end: SessionSeq }
  /** The price of the content the request no longer carries, in UTF-8 bytes. */
  readonly shadowedBytes: number
  /** What the request carries for each shadowed seq. */
  readonly replacements: ReadonlyArray<CompactReplacement>
}
