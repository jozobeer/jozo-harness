import { Data } from 'effect'
import type { Effect, Schema } from 'effect'
import type { ContentBlock } from '@jozo-harness/llm'
import type { DiffRecorder, FileDiff } from './diffs.ts'
import type { SpillWriter } from './spill.ts'

export type ToolErrorCode =
  | 'invalid-arguments'
  | 'unknown-tool'
  | 'denied'
  | 'duplicate-tool'
  | 'execution'

/** A tool failure. The pipeline turns every failure into a model-visible error result. */
export class ToolError extends Data.TaggedError('ToolError')<{
  readonly code: ToolErrorCode
  readonly message: string
}> {}

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
  readonly isConcurrencySafe?: (args: A) => boolean
  readonly timeoutMs?: number
  readonly finalizeContent?: (
    exec: ToolExecution,
    result: ToolExecutionResult,
  ) => ReadonlyArray<ContentBlock> | undefined
  readonly presentCall?: (args: A) => ToolCallView
  readonly presentResult?: (args: A, result: ToolResultView) => ToolResultView
}
