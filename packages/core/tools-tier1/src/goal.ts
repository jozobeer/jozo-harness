import { Schema, Effect } from 'effect'
import type { SessionEvent } from '@jozo-harness/session'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import {
  currentGoal,
  DEFAULT_MAX_GOAL_ROUNDS,
  goalRounds,
  inGoalRound,
  inHumanTurn,
  MIN_BLOCKED_ROUNDS,
  type GoalPhase,
  type GoalState,
} from './goal-state.ts'

const ACTIONS = ['read', 'create', 'edit', 'pause', 'resume', 'complete', 'blocked'] as const

const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      'read reports the current goal; create starts a new goal; edit changes its words; pause, resume, complete, and blocked move its phase.',
  }),
  objective: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The outcome the work pursues, in one sentence. Required with create.',
    }),
  ),
  note: Schema.optionalKey(
    Schema.String.annotate({ description: 'Anything the objective alone does not say.' }),
  ),
  maxGoalRounds: Schema.optionalKey(
    Schema.Int.annotate({ description: 'How many rounds the goal may run. Defaults to 256.' }),
  ),
  blockedReason: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Required with blocked: the concrete condition that stops progress.',
    }),
  ),
})

export type GoalArgs = Schema.Schema.Type<typeof Parameters>

export interface GoalValue {
  readonly action: string
  readonly objective: string
  readonly phase: GoalPhase
  readonly rounds: number
  readonly maxGoalRounds: number
  readonly note?: string
  readonly blockedReason?: string
}

/** Where the goal lives: the session log, which is also what makes it durable. */
export interface GoalLog {
  /** Everything the session recorded so far. */
  readonly events: () => ReadonlyArray<SessionEvent>
  /** Records the newest state; the last one written is the goal. */
  readonly append: (state: GoalState) => Effect.Effect<void, ToolError>
}

const valueOf = (action: string, state: GoalState, rounds: number): GoalValue => ({
  action,
  objective: state.objective,
  phase: state.phase,
  rounds,
  maxGoalRounds: state.maxGoalRounds,
  ...(state.note === undefined ? {} : { note: state.note }),
  ...(state.blockedReason === undefined ? {} : { blockedReason: state.blockedReason }),
})

const record = (action: string, state: GoalState, log: GoalLog) =>
  log.append(state).pipe(Effect.map(() => valueOf(action, state, goalRounds(log.events()))))

const refuse = (message: string) => new ToolError({ code: 'invalid-arguments', message })

/** Reads the goal back without writing: a resumed session can ask where it stands. */
const readGoal = (log: GoalLog) => {
  const current = currentGoal(log.events())
  return current === undefined
    ? Effect.fail(refuse('there is no goal to read'))
    : Effect.succeed(valueOf('read', current, goalRounds(log.events())))
}

const createGoal = (args: GoalArgs, log: GoalLog) => {
  if (currentGoal(log.events()) !== undefined) {
    return Effect.fail(refuse('a goal already exists; use action edit to change it'))
  }
  return args.objective === undefined || args.objective.trim() === ''
    ? Effect.fail(refuse('objective is required to create a goal'))
    : record(
        'create',
        {
          objective: args.objective,
          phase: 'active',
          maxGoalRounds: args.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
          ...(args.note === undefined ? {} : { note: args.note }),
        },
        log,
      )
}

const editGoal = (args: GoalArgs, current: GoalState, log: GoalLog) => {
  const note = args.note ?? current.note
  return record(
    'edit',
    {
      objective: args.objective ?? current.objective,
      phase: current.phase,
      maxGoalRounds: args.maxGoalRounds ?? current.maxGoalRounds,
      ...(note === undefined ? {} : { note }),
      ...(current.blockedReason === undefined ? {} : { blockedReason: current.blockedReason }),
    },
    log,
  )
}

/** The phase an action moves the goal to. */
const phaseOf = (action: string): GoalPhase =>
  action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'complete'

/**
 * Moves the phase: complete is the model's to give, but pause and resume are a
 * person's decisions, so a turn the model started on its own may not make them.
 */
const movePhase = (args: GoalArgs, current: GoalState, log: GoalLog) => {
  if (args.action === 'pause' || args.action === 'resume') {
    if (!inHumanTurn(log.events())) {
      return Effect.fail(
        refuse(
          args.action +
            ' needs a turn a human started; a model turn cannot ' +
            args.action +
            ' a goal',
        ),
      )
    }
  }
  return setPhase(args.action, phaseOf(args.action), current, log)
}

const blockGoal = (args: GoalArgs, current: GoalState, log: GoalLog) => {
  const reason = args.blockedReason
  if (reason === undefined || reason.trim() === '') {
    return Effect.fail(refuse('blockedReason is required with action blocked'))
  }
  const events = log.events()
  const rounds = goalRounds(events)
  if (!inHumanTurn(events) && inGoalRound(events) && rounds < MIN_BLOCKED_ROUNDS) {
    return Effect.fail(
      refuse(
        'blocked needs at least ' +
          String(MIN_BLOCKED_ROUNDS) +
          ' rounds behind it; this is round ' +
          String(rounds) +
          ' and the same condition has not persisted yet',
      ),
    )
  }
  return record('blocked', { ...current, phase: 'blocked', blockedReason: reason }, log)
}

/** A phase change leaves the blocker behind: it described the phase that just ended. */
const setPhase = (action: string, phase: GoalPhase, current: GoalState, log: GoalLog) =>
  record(
    action,
    {
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
      ...(current.note === undefined ? {} : { note: current.note }),
    },
    log,
  )

/** The line the model reads back: the phase, the objective, and any note or blocker. */
export const goalText = (value: GoalValue): string =>
  'goal ' +
  value.phase +
  ' ' +
  String(value.rounds) +
  '/' +
  String(value.maxGoalRounds) +
  ': ' +
  value.objective +
  (value.note === undefined ? '' : '\n' + value.note) +
  (value.blockedReason === undefined ? '' : '\nblocked: ' + value.blockedReason)

/**
 * Runs one goal action against one log. The tool and the human's command share
 * this, so both write the same state and both refuse for the same reasons.
 */
export const runGoal = (args: GoalArgs, log: GoalLog): Effect.Effect<GoalValue, ToolError> =>
  Effect.gen(function* () {
    if (args.action === 'read') return yield* readGoal(log)
    if (args.action === 'create') return yield* createGoal(args, log)
    const current = currentGoal(log.events())
    if (current === undefined) {
      return yield* Effect.fail(refuse('there is no goal to ' + args.action))
    }
    if (args.action === 'edit') return yield* editGoal(args, current, log)
    if (args.action === 'blocked') return yield* blockGoal(args, current, log)
    return yield* movePhase(args, current, log)
  })

/**
 * Records and moves the goal the session works toward. Each call writes one state
 * to the log, so a resumed session reads the goal back from the log alone.
 */
export const makeGoalTool = (log: GoalLog): ToolDefinition<GoalArgs, GoalValue> => ({
  name: 'goal',
  description:
    'Records the objective this session works toward and how it stands. Use action read to check the objective, phase, and rounds; while the phase is active the next round runs on its own, so complete it when the objective is achieved and block it only for a condition that persists.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      action: Schema.String,
      objective: Schema.String,
      phase: Schema.Literals(['active', 'paused', 'blocked', 'complete']),
      rounds: Schema.Int,
      maxGoalRounds: Schema.Int,
      note: Schema.optionalKey(Schema.String),
      blockedReason: Schema.optionalKey(Schema.String),
    }),
    render: (_args, value) => [{ type: 'text', text: goalText(value) }],
  },
  execute: (args) => runGoal(args, log),
})
