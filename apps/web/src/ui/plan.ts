import { toolsOf, type TraceTool, type TraceTurn } from './trace.ts'

/** How a plan stands: waiting for the human, approved, or kept with a reason. */
export type PlanVerdict = 'proposed' | 'approved' | 'kept'

/** The plan one call proposed, as the conversation reads it. */
export interface PlanView {
  /** The plan in full, Markdown, as the model wrote it. */
  readonly text: string
  readonly verdict: PlanVerdict
  /** What the human said when keeping plan mode; '' while it waits or once approved. */
  readonly reason: string
  /** The choices the question offered, in the order the log recorded them; empty before it arrives. */
  readonly options: ReadonlyArray<string>
}

/** The tool whose arguments carry a plan. */
export const PLAN_TOOL = 'exit_plan_mode'

/** The arguments arrive as unknown JSON; a field is read only where it is a string. */
const fieldOf = (data: unknown, key: string): unknown =>
  typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined

/** The plan inside a call's arguments; '' when the call carried none this page can read. */
const textOf = (args: string): string => {
  try {
    const parsed: unknown = JSON.parse(args)
    const plan = fieldOf(parsed, 'plan')
    return typeof plan === 'string' ? plan : ''
  } catch {
    return ''
  }
}

/**
 * The question offers approval first, so the answer says whether plan mode ended:
 * the offered word approves, and any other answer is the human's reason to stay.
 */
const verdictOf = (ask: TraceTool['ask']): PlanVerdict => {
  if (ask === undefined || ask.answer === '') return 'proposed'
  const approval = ask.options[0] ?? ''
  const answer = ask.answer.trim().toLowerCase()
  return approval !== '' && answer === approval.trim().toLowerCase() ? 'approved' : 'kept'
}

/** The plan a call proposed; undefined for a call that proposed none. */
export const planOf = (tool: TraceTool): PlanView | undefined => {
  const text = tool.name === PLAN_TOOL ? textOf(tool.args) : ''
  if (text === '') return undefined
  const verdict = verdictOf(tool.ask)
  return {
    text,
    verdict,
    reason: verdict === 'kept' ? (tool.ask?.answer ?? '') : '',
    options: tool.ask?.options ?? [],
  }
}

/** The call that proposed one plan, found by its id so a pane can reopen it after a reload. */
export const planToolOf = (
  turns: ReadonlyArray<TraceTurn>,
  callId: string,
): TraceTool | undefined => turns.flatMap(toolsOf).findLast((tool) => tool.callId === callId)
