export * from './read.ts'
export * from './write.ts'
export * from './workspace.ts'
export * from './present.ts'
export * from './bash.ts'
export * from './edit.ts'
export * from './glob.ts'
export * from './grep.ts'
export * from './walk.ts'
export * from './text.ts'
export * from './observed-files.ts'
export * from './worktree.ts'

import { noneSandbox, type ApprovalShape, type SandboxShape } from '@jozo-harness/safety'
import type { ToolDefinition } from '@jozo-harness/tools'
import { makeReadTool } from './read.ts'
import { makeWriteTool } from './write.ts'
import { makeEditTool } from './edit.ts'
import { globTool } from './glob.ts'
import { grepTool } from './grep.ts'
import { makeBashTool, type TimeoutJobs } from './bash.ts'
import { makeObservedFiles, type ObservedFiles } from './observed-files.ts'
import { makeWorktreeTool, type WorktreeHost } from './worktree.ts'

/**
 * Every Tier 0 tool, with the sandbox the caller chose for bash and the approval
 * seam it escalates through. Without a seam the escalation arguments are refused.
 */
export const tier0Tools = (
  sandbox: SandboxShape = noneSandbox,
  observed: ObservedFiles = makeObservedFiles(),
  approval?: ApprovalShape,
  /** Present when the run has background jobs; a timed-out bash call is promoted to one. */
  jobs?: TimeoutJobs,
  /** Present when the session can change its workspace; the worktree tool needs it. */
  worktree?: WorktreeHost,
): ReadonlyArray<ToolDefinition<any, any>> => [
  makeReadTool(observed),
  makeWriteTool(observed, sandbox, approval),
  makeEditTool(observed, sandbox, approval),
  globTool,
  grepTool,
  makeBashTool(sandbox, approval, jobs),
  ...(worktree === undefined ? [] : [makeWorktreeTool(sandbox, approval, worktree)]),
]
export * from './plugin.ts'
