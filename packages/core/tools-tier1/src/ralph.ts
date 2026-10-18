import { Cause, Effect, Exit, Schema } from 'effect'
import type { Agent, AgentsShape } from '@jozo-harness/agent'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { childAnswerOf } from './child-answer.ts'

/** The highest round budget a caller may ask for; a caller can only lower it. */
export const RALPH_MAX_ROUNDS = 256

/** What one worker report or the parent's result may cost before it is clipped. */
export const RALPH_HANDOFF_BYTES = 16 * 1024

/** The same budget for the result the parent reads. */
export const RALPH_RESULT_BYTES = 16 * 1024

export const RALPH_STATUSES = ['continue', 'complete', 'blocked'] as const
export type RalphReportStatus = (typeof RALPH_STATUSES)[number]
export type RalphOutcomeStatus = RalphReportStatus | 'budget-limited' | 'round-failed'

/** One worker's answer: what it did, what it proved, and what comes next. */
export interface RalphReport {
  readonly status: RalphReportStatus
  readonly summary: string
  readonly evidence: ReadonlyArray<string>
  readonly nextSteps: ReadonlyArray<string>
  readonly blocker?: string
}

/** What the parent sees: the loop's fate and the last report it read. */
export interface RalphOutcome {
  readonly status: RalphOutcomeStatus
  readonly rounds: number
  readonly report: RalphReport | null
  readonly error?: string
}

export type RalphReportParse =
  | { readonly kind: 'report'; readonly report: RalphReport }
  | { readonly kind: 'invalid'; readonly reason: string }

const ReportSchema = Schema.Struct({
  status: Schema.Literals([...RALPH_STATUSES]),
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  nextSteps: Schema.Array(Schema.String),
  blocker: Schema.optionalKey(Schema.String),
})

const OutcomeSchema = Schema.Struct({
  status: Schema.Literals([...RALPH_STATUSES, 'budget-limited', 'round-failed']),
  rounds: Schema.Int,
  report: Schema.NullOr(ReportSchema),
  error: Schema.optionalKey(Schema.String),
})

const Parameters = Schema.Struct({
  objective: Schema.String.annotate({
    description:
      'The immutable objective every round works toward. Each round starts fresh and sees only this and the previous round report.',
  }),
  maxRounds: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        'The most rounds to run. Defaults to 256, the ceiling; a smaller number can only lower the budget.',
    }),
  ),
})

export type RalphArgs = Schema.Schema.Type<typeof Parameters>

/** The host a Ralph loop runs on: the parent's agents registry and route. */
export interface RalphHost {
  readonly agents: AgentsShape
  readonly route: string
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length

/**
 * Cuts text to a byte budget at a code-point boundary and says it was cut, so a
 * clipped handoff or result is readable as clipped rather than silently short.
 */
export const clipRalphText = (text: string, maxBytes: number, label: string): string => {
  if (byteLength(text) <= maxBytes) return text
  const marker = '\n[' + label + ' truncated after ' + String(maxBytes) + ' bytes]'
  const encoded = new TextEncoder().encode(text)
  let end = Math.max(maxBytes - byteLength(marker), 0)
  // Back up to the start of a code point instead of cutting it in half.
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return new TextDecoder().decode(encoded.slice(0, end)) + marker
}

const invalid = (reason: string): RalphReportParse => ({ kind: 'invalid', reason })

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

const isTextArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every(isText)

const isReportStatus = (value: unknown): value is RalphReportStatus =>
  RALPH_STATUSES.some((status) => status === value)

const continueProblem = (report: RalphReport): string | undefined => {
  if (report.nextSteps.length === 0) return 'continue needs at least one next step'
  if (report.blocker !== undefined) return 'continue cannot carry a blocker'
  return undefined
}

const completeProblem = (report: RalphReport): string | undefined => {
  if (report.evidence.length === 0) return 'complete needs at least one evidence item'
  if (report.nextSteps.length > 0) return 'complete cannot name next steps'
  return undefined
}

const blockedProblem = (report: RalphReport): string | undefined =>
  report.blocker === undefined ? 'blocked needs a non-empty blocker' : undefined

/** The rules that depend on the status: each ending must name what it needs. */
const reportProblem = (report: RalphReport): string | undefined => {
  if (report.status === 'continue') return continueProblem(report)
  if (report.status === 'complete') return completeProblem(report)
  return blockedProblem(report)
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface ReportText {
  readonly summary: string
  readonly evidence: ReadonlyArray<string>
  readonly nextSteps: ReadonlyArray<string>
  readonly blocker: string
}

type TextParse =
  | { readonly kind: 'ok'; readonly text: ReportText }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Reads the four fields that do not change the status's meaning. */
const readReportText = (record: Readonly<Record<string, unknown>>): TextParse => {
  if (!isText(record.summary)) {
    return { kind: 'invalid', reason: 'summary must be a non-empty string' }
  }
  if (!isTextArray(record.evidence)) {
    return { kind: 'invalid', reason: 'evidence must be an array of non-empty strings' }
  }
  if (!isTextArray(record.nextSteps)) {
    return { kind: 'invalid', reason: 'nextSteps must be an array of non-empty strings' }
  }
  if (record.blocker !== undefined && typeof record.blocker !== 'string') {
    return { kind: 'invalid', reason: 'blocker must be a string' }
  }
  return {
    kind: 'ok',
    text: {
      summary: record.summary,
      evidence: record.evidence,
      nextSteps: record.nextSteps,
      blocker: typeof record.blocker === 'string' ? record.blocker.trim() : '',
    },
  }
}

/** Builds the report once every field has the type the contract names. */
const readReport = (record: Readonly<Record<string, unknown>>): RalphReportParse => {
  if (!isReportStatus(record.status)) {
    return invalid('status must be continue, complete, or blocked')
  }
  const parsed = readReportText(record)
  if (parsed.kind === 'invalid') return invalid(parsed.reason)
  const { summary, evidence, nextSteps, blocker } = parsed.text
  const report: RalphReport = {
    status: record.status,
    summary,
    evidence,
    nextSteps,
    ...(blocker === '' ? {} : { blocker }),
  }
  const problem = reportProblem(report)
  return problem === undefined ? { kind: 'report', report } : invalid(problem)
}

/**
 * Reads one worker's last message as a report. The answer must be JSON itself:
 * no code fence and no prose, so a worker that cannot follow the contract stops
 * its round instead of pretending an unreadable answer was understood.
 */
export const parseRalphReport = (text: string): RalphReportParse => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return invalid('the answer is not JSON')
  }
  return isRecord(value) ? readReport(value) : invalid('the answer is not a JSON object')
}

/** The prompt one fresh child receives; it has no parent conversation to lean on. */
export const renderRalphPrompt = (
  objective: string,
  round: number,
  maxRounds: number,
  handoff: string,
): string =>
  '<ralph_round>\n' +
  'Objective: ' +
  objective +
  '\nRound: ' +
  String(round) +
  '/' +
  String(maxRounds) +
  '\nPrevious handoff:\n' +
  (handoff === '' ? '(none)' : handoff) +
  '\n\n' +
  'Work toward the objective in the workspace. You start fresh: the workspace and the ' +
  'previous handoff are the only memory you get. Make concrete progress and verify it.\n' +
  'Return only a JSON object, with no code fence and no text around it:\n' +
  '{"status":"continue"|"complete"|"blocked","summary":"...","evidence":["..."],"nextSteps":["..."],"blocker":"..."}\n' +
  'Use continue with at least one next step and no blocker while work remains. Use complete ' +
  'with at least one evidence item and no next step only when the whole objective is done. ' +
  'Use blocked with a non-empty blocker only when you cannot make meaningful progress.\n' +
  '</ralph_round>'

const roundFailed = (rounds: number, report: RalphReport | null, error: string): RalphOutcome => ({
  status: 'round-failed',
  rounds,
  report,
  error,
})

const renderReport = (report: RalphReport | null): string =>
  report === null ? '' : '\n' + JSON.stringify(report, null, 2)

const renderOutcome = (outcome: RalphOutcome): string => {
  const rounds = String(outcome.rounds)
  const selfReport = "this is the worker's own report, not a verified pass"
  const text =
    outcome.status === 'complete'
      ? 'the worker reported complete after ' + rounds + ' round(s); ' + selfReport + '.'
      : outcome.status === 'blocked'
        ? 'the worker reported blocked after ' + rounds + ' round(s); ' + selfReport + '.'
        : outcome.status === 'budget-limited'
          ? 'the loop stopped at its ' +
            rounds +
            "-round budget; the last worker report is below. It is the worker's own report, not a verified pass."
          : 'round ' +
            rounds +
            ' failed: ' +
            (outcome.error ?? 'unknown reason') +
            '. The loop stopped.'
  return clipRalphText(text + renderReport(outcome.report), RALPH_RESULT_BYTES, 'result')
}

const runOneRound = (input: {
  readonly host: RalphHost
  readonly objective: string
  readonly round: number
  readonly maxRounds: number
  readonly handoff: string
  readonly cwd: string
  readonly parent: string
  readonly workerIds: Set<string>
  readonly onChild: (child: Agent) => void
}) =>
  Effect.gen(function* () {
    const child = yield* input.host.agents
      .create({
        cwd: input.cwd,
        options: { route: input.host.route },
        seed: [],
        parent: input.parent,
      })
      .pipe(Effect.orElseSucceed(() => undefined))
    if (child === undefined) return { kind: 'failed' as const, error: 'cannot start a child agent' }
    input.workerIds.add(child.id)
    input.onChild(child)
    const taken = yield* child
      .followup({
        text: renderRalphPrompt(input.objective, input.round, input.maxRounds, input.handoff),
        source: 'user',
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    if (!taken) return { kind: 'failed' as const, error: 'the child agent took no message' }
    yield* child.whenIdle
    const answer = childAnswerOf(child)
    if (answer.trim() === '')
      return { kind: 'failed' as const, error: 'the child answered with nothing' }
    const parsed = parseRalphReport(answer)
    if (parsed.kind === 'invalid') return { kind: 'failed' as const, error: parsed.reason }
    return { kind: 'report' as const, report: parsed.report }
  })

/**
 * Runs fresh children toward one objective, handing each round the previous
 * report and nothing from this conversation. The loop ends when a worker reports
 * complete or blocked, when the round budget runs out, or when a round fails.
 */
export const makeRalphTool = (host: RalphHost): ToolDefinition<RalphArgs, RalphOutcome> => {
  // The child registry is shared with the parent, so the tool itself remembers the
  // sessions it started and refuses a call made from one of them.
  const workerIds = new Set<string>()
  return {
    name: 'ralph',
    description:
      'Runs fresh child agents toward one immutable objective, one round at a time. Each round starts from nothing and sees only the objective and the previous round report. The parent waits until a worker reports complete or blocked, the round budget runs out, or a round fails. Use it only when the human explicitly asks for a Ralph or fresh-agent loop; ordinary long work belongs to goal.',
    parameters: Parameters,
    output: {
      schema: OutcomeSchema,
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value) }],
    },
    execute: (args, context) => {
      if (workerIds.has(context.sessionId)) {
        return Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'ralph cannot run inside a ralph worker',
          }),
        )
      }
      const maxRounds = Math.min(args.maxRounds ?? RALPH_MAX_ROUNDS, RALPH_MAX_ROUNDS)
      if (maxRounds < 1) {
        return Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'maxRounds must be at least 1',
          }),
        )
      }
      let current: Agent | undefined = undefined
      let report: RalphReport | null = null
      let handoff = ''
      const loop = Effect.gen(function* () {
        for (let round = 1; round <= maxRounds; round += 1) {
          const result = yield* runOneRound({
            host,
            objective: args.objective,
            round,
            maxRounds,
            handoff,
            cwd: context.cwd,
            parent: context.sessionId,
            workerIds,
            onChild: (child) => {
              current = child
            },
          })
          if (result.kind === 'failed') return roundFailed(round, report, result.error)
          const next = result.report
          report = next
          handoff = clipRalphText(JSON.stringify(next), RALPH_HANDOFF_BYTES, 'handoff')
          current = undefined
          if (next.status === 'complete' || next.status === 'blocked') {
            return { status: next.status, rounds: round, report: next } satisfies RalphOutcome
          }
        }
        return { status: 'budget-limited', rounds: maxRounds, report } satisfies RalphOutcome
      })
      return loop.pipe(
        Effect.onExit((exit) => {
          if (current === undefined || Exit.isSuccess(exit) || !Cause.hasInterrupts(exit.cause)) {
            return Effect.void
          }
          return current.cancel('parent-cancelled')
        }),
      )
    },
  }
}
