import type { ToolSchema } from '@jozo-harness/llm'
import type { ToolSignature } from '@jozo-harness/tools'
import { Data, type Effect } from 'effect'

export type PromptErrorCode =
  | 'duplicate-section'
  | 'duplicate-context'
  | 'multiple-complete'
  | 'unknown-variable'

/** A failure of prompt registration or assembly. */
export class PromptError extends Data.TaggedError('PromptError')<{
  readonly code: PromptErrorCode
  readonly message: string
}> {}

/** What a section may read when it renders. */
export interface AssembleContext {
  readonly variables: Readonly<Record<string, string>>
  /** The model-facing tools of this assembly; absent when only the text renders. */
  readonly tools?: ReadonlyArray<ToolSchema>
  /** The same tools with their argument and result schemas, for the signature section. */
  readonly signatures?: ReadonlyArray<ToolSignature>
}

/** What a runtime context provider may read when the loop renders a snapshot. */
export interface RuntimeContextSubject {
  readonly cwd: string
  /** The agent whose step is being assembled, when the loop knows it. */
  readonly agentId?: string
}

/**
 * One fact that can change between requests. The loop renders the entries into a
 * user message with `source: 'runtime-context'` and appends it only when it differs
 * from the newest one in the log.
 */
export interface RuntimeContextEntry {
  readonly name: string
  /** Ascending. Entries with the same order sort by name code-unit. */
  readonly order: number
  /** The line body, e.g. `cwd: /work`. Returning undefined or '' omits the fact. */
  readonly text: (subject: RuntimeContextSubject) => Effect.Effect<string | undefined>
}

export interface PromptSection {
  readonly name: string
  /** Ascending. Sections with the same order sort by name code-unit. */
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  /** This section alone replaces the whole prompt. */
  readonly complete?: boolean
}

/** One assembled request preamble: the system prompt and the tools the model may call. */
export interface PromptBuild {
  readonly system: string
  /** The names of the sections that rendered into this prompt, in assembly order. */
  readonly sections: ReadonlyArray<string>
  readonly tools: ReadonlyArray<ToolSchema>
}
