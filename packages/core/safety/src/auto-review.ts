import type { ToolExecution, ToolGuard } from '@jozo-harness/tools'
import { Context, Duration, Effect, Layer } from 'effect'
import type { AutoReviewed } from './events.ts'
import type { PermissionPreset } from './policy.ts'

/** One call as the reviewer sees it. The reviewer reads the call, not the conversation. */
export interface AutoReviewRequest {
  readonly callId: string
  readonly tool: string
  readonly arguments: string
  readonly cwd: string
}

/** The reviewer's verdict. A reviewer that cannot answer denies. */
export type AutoReviewDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }

/** Answers one call. The model-backed one asks a model; a test hands over a fake. */
export type AutoReviewReviewer = (request: AutoReviewRequest) => Effect.Effect<AutoReviewDecision>

export interface AutoReviewShape {
  /**
   * Installs the reviewer every later call goes to. While nobody is served a call
   * is denied at once, because a preset that promises review must not run the call
   * when the reviewer it promised is missing.
   */
  readonly serve: (reviewer: AutoReviewReviewer) => Effect.Effect<void>
  /** Says that nobody reviews any more; later calls are denied at once. */
  readonly stopServing: () => Effect.Effect<void>
  /** Whether somebody reviews. */
  readonly served: () => boolean
  /** Reviews one call; an absent or failing reviewer denies rather than allows. */
  readonly review: (request: AutoReviewRequest) => Effect.Effect<AutoReviewDecision>
}

const ABSENT_REVIEWER: AutoReviewDecision = {
  kind: 'deny',
  reason: 'no auto reviewer is installed',
}

const FAILED_REVIEWER: AutoReviewDecision = {
  kind: 'deny',
  reason: 'the auto reviewer failed before it answered',
}

/** The review seam as a service, so a run can install the model-backed reviewer. */
export class AutoReview extends Context.Service<AutoReview, AutoReviewShape>()(
  'jozo-harness/AutoReview',
) {}

/**
 * The review holder. Like approval it is a seam, not a policy of its own: the
 * preset decides whether a guard asks it, and the holder only remembers who
 * answers.
 */
export const makeAutoReview = (): Effect.Effect<AutoReviewShape> =>
  Effect.sync(() => {
    let reviewer: AutoReviewReviewer | undefined
    return {
      serve: (review) =>
        Effect.sync(() => {
          reviewer = review
        }),
      stopServing: () =>
        Effect.sync(() => {
          reviewer = undefined
        }),
      served: () => reviewer !== undefined,
      review: (request) =>
        reviewer === undefined
          ? Effect.succeed(ABSENT_REVIEWER)
          : reviewer(request).pipe(Effect.catchCause(() => Effect.succeed(FAILED_REVIEWER))),
    }
  })

export const autoReviewServiceLayer: Layer.Layer<AutoReview, never> = Layer.effect(
  AutoReview,
  makeAutoReview(),
)

/** What the reviewer is told; it answers in one word so the parse is not a guess. */
const AUTO_REVIEW_INSTRUCTION = [
  'You review one tool call before it runs in a session whose permission preset is auto.',
  'A call with effects outside its own result runs only when you allow it.',
  'Answer with exactly one line: ALLOW, or DENY: <one sentence reason>.',
  'Deny a call that is destructive, unsafe, or unrelated to the work its arguments describe.',
  'You see the call alone, so deny only what its own words make clear.',
].join('\n')

export const autoReviewPrompt = (request: AutoReviewRequest): string =>
  [
    AUTO_REVIEW_INSTRUCTION,
    '',
    'tool: ' + request.tool,
    'working directory: ' + request.cwd,
    'arguments: ' + request.arguments,
  ].join('\n')

const DENIED_ANSWER = /^DENY\s*:?\s*([\s\S]*)$/i

/**
 * Reads the reviewer's line. Only an explicit ALLOW allows: an answer this does
 * not understand is a denial, so a chatty or truncated model cannot widen what
 * runs.
 */
export const parseAutoReviewAnswer = (answer: string): AutoReviewDecision => {
  const line = answer.trim()
  if (line.toUpperCase().startsWith('ALLOW')) return { kind: 'allow' }
  const denied = DENIED_ANSWER.exec(line)
  if (denied !== null) {
    const reason = (denied[1] ?? '').trim()
    return { kind: 'deny', reason: reason.length === 0 ? 'the reviewer denied the call' : reason }
  }
  return { kind: 'deny', reason: 'the reviewer did not answer ALLOW or DENY' }
}

/** One model round trip: the prompt in, the answer text out. */
export type AutoReviewCompletion = (prompt: string) => Effect.Effect<string, unknown>

/** The answer a reviewer waits for; past it the call is denied rather than run unreviewed. */
export const AUTO_REVIEW_TIMEOUT_MS = 30_000

const NO_ANSWER: AutoReviewDecision = {
  kind: 'deny',
  reason: 'the reviewer did not answer before the deadline',
}

/**
 * Asks a model once per call. A failure or a timeout denies: asking the human
 * instead would stall a run that has nobody at the terminal, and a denied call can
 * be retried, so the safe default is the one that leaves the workspace untouched.
 */
export const modelAutoReview = (
  complete: AutoReviewCompletion,
  timeoutMs: number = AUTO_REVIEW_TIMEOUT_MS,
): AutoReviewReviewer => {
  return (request) =>
    complete(autoReviewPrompt(request)).pipe(
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.map(parseAutoReviewAnswer),
      Effect.catchCause(() => Effect.succeed(NO_ANSWER)),
    )
}

export interface AutoReviewGuardOptions {
  /** Read on each call so a session that leaves auto stops asking the reviewer. */
  readonly preset: () => PermissionPreset
  readonly review: AutoReviewShape
  /** Whether one tool's calls have no effect outside their own result. */
  readonly isReadOnly: (tool: string) => boolean
  /** Where a verdict goes. A write that fails does not change the verdict. */
  readonly record?: (reviewed: AutoReviewed) => Effect.Effect<void>
}

const recordDecision = (
  options: AutoReviewGuardOptions,
  exec: ToolExecution,
  decision: AutoReviewDecision,
): Effect.Effect<void> => {
  if (options.record === undefined) return Effect.void
  const reviewed: AutoReviewed = {
    sessionId: exec.context.sessionId,
    callId: exec.callId,
    tool: exec.tool,
    decision: decision.kind === 'deny' ? 'denied' : 'allowed',
    ...(decision.kind === 'deny' ? { reason: decision.reason } : {}),
  }
  return options.record(reviewed).pipe(Effect.catchCause(() => Effect.void))
}

/**
 * The guard auto adds to the tool pipeline. It abstains outside auto, for a
 * read-only tool, and for a call a program made: the outer `run_code` call was
 * reviewed, so asking once per nested call would repeat one decision and stall the
 * program on answers it cannot route.
 */
export const autoReviewGuard = (options: AutoReviewGuardOptions): ToolGuard => ({
  name: 'auto-review',
  check: (exec) =>
    Effect.gen(function* () {
      if (options.preset() !== 'auto') return { kind: 'abstain' as const }
      if (exec.context.nested === true) return { kind: 'abstain' as const }
      if (options.isReadOnly(exec.tool)) return { kind: 'abstain' as const }
      const decision = yield* options.review.review({
        callId: exec.callId,
        tool: exec.tool,
        arguments: exec.arguments,
        cwd: exec.context.cwd,
      })
      yield* recordDecision(options, exec, decision)
      return decision.kind === 'deny'
        ? { kind: 'deny' as const, reason: decision.reason }
        : { kind: 'abstain' as const }
    }),
})
