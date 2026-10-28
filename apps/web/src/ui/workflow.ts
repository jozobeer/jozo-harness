import type { TraceTool } from './trace.ts'

/** The tool whose result names a run of child agents. */
export const WORKFLOW_TOOL = 'workflow'

/** How one child of a run ended. */
export type WorkflowChildStatus = 'done' | 'failed'

/** One child a workflow ran: what it was called, how it went, and its session. */
export interface WorkflowChild {
  readonly name: string
  readonly status: WorkflowChildStatus
  /** Why the child failed; '' when it finished. */
  readonly reason: string
  /** The child's own session; '' when it never started one. */
  readonly sessionId: string
}

/** A workflow call as the conversation draws it. */
export interface WorkflowRunView {
  /** The script's own outcome line; '' for a fan-out run. */
  readonly headline: string
  readonly children: ReadonlyArray<WorkflowChild>
}

/** The heading the tool writes before the lines that name its children. */
const CHILD_HEAD = '\nchild sessions:\n'

/** One child line: name, outcome, why it failed, and the session it ran in. */
const CHILD_LINE = /^(.+?): (done|failed)(?: \((.*)\))?(?: \[child session: ([^\]\s]+)\])?$/

const statusOf = (word: string): WorkflowChildStatus => (word === 'failed' ? 'failed' : 'done')

/** One child line as a row; undefined for a line the block does not shape. */
const childOf = (line: string): WorkflowChild | undefined => {
  const match = CHILD_LINE.exec(line)
  if (match === null) return undefined
  const name = match[1]
  const status = match[2]
  if (name === undefined || status === undefined) return undefined
  return {
    name,
    status: statusOf(status),
    reason: match[3] ?? '',
    sessionId: match[4] ?? '',
  }
}

/**
 * The children the result names. The block is the last thing the tool writes,
 * so its heading is taken from the end: a child's answer may quote the heading.
 */
const childrenOf = (output: string): ReadonlyArray<WorkflowChild> => {
  const at = output.lastIndexOf(CHILD_HEAD)
  if (at < 0) return []
  return output
    .slice(at + CHILD_HEAD.length)
    .split('\n')
    .flatMap((line) => {
      const child = childOf(line)
      return child === undefined ? [] : [child]
    })
}

/** The script's outcome line, when the run had a script; '' for a fan-out. */
const headlineOf = (output: string): string => {
  const first = output.split('\n')[0] ?? ''
  return first.startsWith('workflow script') ? first : ''
}

/**
 * The workflow a call ran, read from the result the log kept: how many children,
 * how each ended, and which session holds it. Undefined for a call to another
 * tool, so nothing but the logged result decides whether a node appears.
 */
export const workflowOf = (tool: TraceTool): WorkflowRunView | undefined =>
  tool.name === WORKFLOW_TOOL
    ? { headline: headlineOf(tool.output), children: childrenOf(tool.output) }
    : undefined
