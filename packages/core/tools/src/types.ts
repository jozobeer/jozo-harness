import { Data, Schema } from 'effect'
import type { Effect } from 'effect'
import type { ContentBlock } from '@jozo-harness/llm'
import type { DiffRecorder, FileDiff } from './diffs.ts'
import type { SpillWriter } from './spill.ts'

/** The codes a tool body gives its own failure. The log schema shares this vocabulary. */
export const TOOL_ERROR_CODES = [
  'invalid-arguments',
  'unknown-tool',
  'denied',
  'duplicate-tool',
  'execution',
  // The run has no backend for what the call asked for; the same call may work elsewhere.
  'unavailable',
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

/** A tool failure. The pipeline turns every failure into a model-visible error result. */
export class ToolError extends Data.TaggedError('ToolError')<{
  readonly code: ToolErrorCode
  readonly message: string
}> {}

/**
 * How a call failed, recorded beside the model-facing text. `timeout` belongs to
 * the pipeline's deadline rather than a tool body, so it stays out of
 * {@link ToolErrorCode}.
 */
export interface ToolErrorInfo {
  /** The error that failed the call: `ToolError`, `TimeoutError`, or a defect's name. */
  readonly name: string
  readonly code: ToolErrorCode | 'timeout'
  /** A short reason the message also carries, for a reader that shows the code alone. */
  readonly reason?: string
}

export const ToolErrorInfoSchema: Schema.Schema<ToolErrorInfo> = Schema.Struct({
  name: Schema.String,
  code: Schema.Literals([...TOOL_ERROR_CODES, 'timeout']),
  reason: Schema.optionalKey(Schema.String),
})

/** What a tool may use besides its Effect context. Cancel arrives as a Fiber interrupt. */
export interface ToolRunContext {
  readonly sessionId: string
  readonly cwd: string
  readonly callId: string
  /**
   * What the routed adapter carries as images. A tool that hands the model an
   * image refuses when the route declares none, instead of returning a block
   * the adapter would drop. Absent when the caller does not know the route.
   */
  readonly images?: 'base64' | 'none'
  /**
   * How to put a result too large to show beside the session. The loop owns the
   * location; a tool that pages its own result asks this for the way back. Absent
   * when nothing will store the text, and then the tool says how to narrow instead.
   */
  readonly spill?: SpillWriter
  /**
   * Where the tool records the file changes this call made. The pipeline owns
   * the collector, so a call's diffs reach the log without the tool knowing how
   * they are stored. Absent when nothing will record them.
   */
  readonly changes?: DiffRecorder
  /**
   * Ends the turn after this call's step, so a tool that settles the
   * conversation does not ask the model for one more answer. Absent when the
   * caller does not own a turn, as with a direct call in a test.
   */
  readonly concludeTurn?: () => void
  /**
   * The call came from a tool rather than from the model, as a `run_code` program
   * makes them. The outer call already carried the decision to run the program,
   * so a policy that asks once per step skips these.
   */
  readonly nested?: true
  /**
   * Adds a fragment the next request should see as a user message. The pipeline
   * collects the fragments on this call's result, so text a tool found reaches
   * the model after the tool result rather than inside it. Absent when nothing
   * will carry the text.
   */
  readonly addContext?: (text: string) => void
}

/** One call as the policy hooks and guards see it. `args` is already decoded. */
export interface ToolExecution {
  readonly callId: string
  readonly tool: string
  /** Raw JSON string exactly as the model produced it. */
  readonly arguments: string
  readonly args: unknown
  readonly context: ToolRunContext
}

/** The settled result of one call. `value` is the canonical tool value for PTC. */
export interface ToolExecutionResult {
  readonly isError: boolean
  readonly content: ReadonlyArray<ContentBlock>
  readonly value?: unknown
  /** What the call changed in the files it wrote, as it ran. */
  readonly diffs?: ReadonlyArray<FileDiff>
  /**
   * Why the call failed. A reader routes on the code instead of parsing the
   * text; a call whose outcome is unknown, rather than failed, carries none.
   */
  readonly error?: ToolErrorInfo
  /**
   * The tool asked the loop to end the turn here. Only a successful result can
   * carry it: a failure still needs the next request to see what went wrong.
   */
  readonly concludesTurn?: true
  /** The fragments the call added for the next request, in the order it added them. */
  readonly context?: ReadonlyArray<string>
}

export interface ToolCallView {
  readonly summary: string
}

export interface ToolResultView {
  readonly isError: boolean
  readonly summary: string
}

export interface ToolCallRequest {
  readonly callId: string
  readonly tool: string
  readonly arguments: string
  readonly context: ToolRunContext
}

export type ToolCallOutcome = ToolExecutionResult

export type PreExecuteDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason: string }

export type GuardDecision =
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'abstain' }

/** A monotonic policy check. A guard only denies or abstains, so hook order cannot bypass it. */
export interface ToolGuard {
  readonly name: string
  readonly check: (exec: ToolExecution) => Effect.Effect<GuardDecision>
}

/**
 * A tool as the system prompt shows it: the argument and result schemas of the
 * tools this request may call. The provider receives only the schema of the
 * call, so the result type would otherwise never reach the model.
 */
export interface ToolSignature {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: Readonly<Record<string, unknown>>
}

/** Filters the tools one scope may see. Plan mode and subagents register their own. */
export interface ToolRestriction {
  readonly name: string
  readonly allows: (tool: string) => boolean
}

/**
 * One tool as packages define it.
 *
 * `output.schema` describes the canonical value for structured consumers (PTC);
 * the model sees `output.render` instead. The pipeline ends a call that
 * outlives its declared `timeoutMs` as an error result that says it timed out.
 */
export interface ToolDefinition<A, V> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema.Schema<A>
  readonly output: {
    readonly schema: Schema.Schema<V>
    readonly render: (args: A, value: V) => ReadonlyArray<ContentBlock>
  }
  readonly execute: (args: A, exec: ToolRunContext) => Effect.Effect<V, ToolError>
  /**
   * The call reads but changes nothing outside its own result. The auto preset
   * leaves such a call unreviewed, the same way the other presets never review.
   */
  readonly readOnly?: boolean
  readonly isConcurrencySafe?: (args: A) => boolean
  readonly timeoutMs?: number
  readonly finalizeContent?: (
    exec: ToolExecution,
    result: ToolExecutionResult,
  ) => ReadonlyArray<ContentBlock> | undefined
  readonly presentCall?: (args: A) => ToolCallView
  readonly presentResult?: (args: A, result: ToolResultView) => ToolResultView
}
