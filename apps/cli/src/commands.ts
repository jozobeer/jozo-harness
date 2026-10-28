import { Effect } from 'effect'
import {
  commandHelp,
  cwdOf,
  DEFAULT_COMPACT_MAX_BYTES,
  FEEDBACK_MEMO_LIMIT,
  FEEDBACK_RATINGS,
  pruneFor,
  rateFeedback,
  statsLineTextOf,
  statsViewOf,
  type CommandsShape,
  type CompactionCheckpoint,
  type CompactOptions,
  type FeedbackRating,
  type Session,
  type SessionHeader,
  type TokenBudget,
} from '@jozo-harness/session'
import {
  currentGoal,
  currentSchedules,
  goalRounds,
  goalText,
  ruleText,
  runGoal,
  scheduleTitle,
  type GoalArgs,
  type GoalLog,
} from '@jozo-harness/tools-tier1'

/** The model the last request went to, as the log recorded it. */
const modelOf = (session: Session): string => {
  const events = session.events()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') return event.data.provider + '/' + event.data.model
  }
  return 'unknown'
}

const goalLine = (session: Session): string => {
  const goal = currentGoal(session.events())
  if (goal === undefined) return 'goal: none'
  const rounds = goalRounds(session.events())
  return (
    'goal: ' +
    goal.phase +
    ' ' +
    String(rounds) +
    '/' +
    String(goal.maxGoalRounds) +
    ' — ' +
    goal.objective
  )
}

const scheduleLines = (session: Session): ReadonlyArray<string> => {
  const schedules = currentSchedules(session.events())
  if (schedules.length === 0) return ['schedules: none']
  return [
    'schedules: ' + String(schedules.length),
    ...schedules.map(
      (schedule) =>
        '  ' + schedule.id + ' ' + ruleText(schedule.rule) + ' ' + scheduleTitle(schedule),
    ),
  ]
}

/**
 * What /status answers: everything a session can say about itself from its log.
 * Without the loop's budget the context stays unknown, and so does anything the
 * log never counted: a missing number reads as an em dash, not as zero.
 */
export const statusText = (session: Session, budget?: TokenBudget): string => {
  const events = session.events()
  const header: SessionHeader = session.header
  return [
    'session: ' + session.id,
    'model: ' + modelOf(session),
    'cwd: ' + cwdOf(events, header),
    'turns: ' + String(events.filter((event) => event.type === 'turn/start').length),
    'stats: ' + statsLineTextOf(statsViewOf(events, budget)),
    goalLine(session),
    ...scheduleLines(session),
  ].join('\n')
}

/**
 * The goal action a command line names. The first word picks pause, resume, done,
 * or edit; anything else is a new objective, and no words at all read the goal.
 */
export const goalRequest = (input: string): GoalArgs | undefined => {
  const trimmed = input.trim()
  if (trimmed === '') return { action: 'read' }
  const [word = '', ...rest] = trimmed.split(/\s+/)
  const action = GOAL_PHASE_WORDS[word]
  if (action !== undefined) return { action }
  if (word !== 'edit') return { action: 'create', objective: trimmed }
  // Without new words there is nothing to edit, so the human gets the usage back.
  const objective = rest.join(' ').trim()
  return objective === '' ? undefined : { action: 'edit', objective }
}

/** The rating one /feedback line names, with the answer and memo it carries. */
export interface FeedbackLine {
  readonly rating: FeedbackRating
  /** The answer's seq; absent names the newest answer. */
  readonly target?: number
  readonly memo?: string
}

/** The help a malformed /feedback line gets. */
export const FEEDBACK_USAGE =
  'usage: /feedback <like|dislike> [#<seq>] [<memo>]\n' +
  '  #<seq> names an answer; without it the newest answer is rated.\n' +
  '  The memo may be up to ' +
  String(FEEDBACK_MEMO_LIMIT) +
  ' characters.'

const isRating = (word: string): word is FeedbackRating =>
  FEEDBACK_RATINGS.some((rating) => rating === word)

/**
 * What a /feedback line names: a verdict, optionally the answer's seq written
 * as #12, and the rest of the line as its memo.
 */
export const feedbackRequest = (input: string): FeedbackLine | undefined => {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim())
  const word = match?.[1]
  if (word === undefined || !isRating(word)) return undefined
  let rest = (match?.[2] ?? '').trim()
  let target: number | undefined
  const targeted = /^#(\d+)(?:\s+([\s\S]*))?$/.exec(rest)
  if (targeted !== null) {
    target = Number(targeted[1])
    rest = (targeted[2] ?? '').trim()
  }
  return {
    rating: word,
    ...(target === undefined ? {} : { target }),
    ...(rest === '' ? {} : { memo: rest }),
  }
}

/** The words that move an existing goal rather than name a new objective. */
const GOAL_PHASE_WORDS: Readonly<Record<string, GoalArgs['action']>> = {
  pause: 'pause',
  resume: 'resume',
  done: 'complete',
}

/**
 * What a human-asked `/compact` folds with: the newest message stays (a request
 * cannot end on nothing), and every older message over the standard price is
 * pruned now. Summarizing a span is the loop's own call, not a command's.
 */
const MANUAL_COMPACT: CompactOptions = {
  retainTokens: 0,
  maxBytes: DEFAULT_COMPACT_MAX_BYTES,
}

/** What an effort is called in an answer: the empty word leaves it to the provider. */
const shownEffort = (effort: string): string => (effort === '' ? 'default' : effort)

/** The word an effort command writes; `default` hands the choice back to the provider. */
const effortWord = (input: string): string => {
  const word = input.trim()
  return word === 'default' ? '' : word
}

/** The session's log as the goal tool writes it; a lost write is a bug, not an answer. */
const goalLogOf = (session: Session): GoalLog => ({
  events: () => session.events(),
  append: (state) => session.append('goal/updated', state).pipe(Effect.orDie),
})

/** What a command registry needs from the session it answers for. */
export interface BuiltinCommandOptions {
  /** The budget the loop compacts with; absent leaves the context stat unknown. */
  readonly budget?: TokenBudget
  /**
   * The loop's summary call, handed in so a human-asked fold can record the
   * checkpoint it earns. Absent leaves `/compact` pruning only.
   */
  readonly compactNow?: () => Effect.Effect<CompactionCheckpoint | undefined>
  /**
   * Whether a turn holds the agent right now. Folding the history under a running
   * turn would rewrite the request it is about to send, so the command refuses.
   */
  readonly isBusy?: () => boolean
}

/** The commands every jozo-harness session answers. */
export const installBuiltinCommands = (
  commands: CommandsShape,
  options: BuiltinCommandOptions = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* commands.register({
      name: 'help',
      summary: 'list the commands this session answers',
      run: () => Effect.succeed({ ok: true, text: commandHelp(commands.list()) }),
    })
    yield* commands.register({
      name: 'status',
      summary: 'where this session stands: model, cwd, turns, token stats, goal, schedules',
      run: (_input, context) =>
        Effect.succeed({ ok: true, text: statusText(context.session, options.budget) }),
    })
    yield* commands.register({
      name: 'model',
      summary: 'switch the route this session asks, as provider/model; alone reads it',
      run: (input, context) =>
        Effect.gen(function* () {
          const control = context.control
          const route = input.trim()
          if (control === undefined) return { ok: false, text: 'no agent here to switch' }
          if (route !== '') yield* control.setModel(route)
          return { ok: true, text: 'model: ' + (route === '' ? control.route() : route) }
        }),
    })
    yield* commands.register({
      name: 'effort',
      summary: 'switch the reasoning effort the provider is asked for; alone reads it',
      run: (input, context) =>
        Effect.gen(function* () {
          const control = context.control
          const word = input.trim()
          const effort = effortWord(word)
          if (control === undefined) return { ok: false, text: 'no agent here to switch' }
          // With no word the command reads; `default` writes the empty word on purpose.
          if (word !== '') yield* control.setEffort(effort)
          return {
            ok: true,
            text: 'effort: ' + shownEffort(word === '' ? control.effort() : effort),
          }
        }),
    })
    yield* commands.register({
      name: 'compact',
      summary: 'fold the oversized parts of this history now',
      run: (_input, context) =>
        Effect.gen(function* () {
          // A fold mid-turn would edit the log the running step already read; the
          // human is told to ask again once the turn is done.
          if (options.isBusy?.() === true) {
            return { ok: false, text: 'a turn is running; /compact after it' }
          }
          const prune = pruneFor(context.session.events(), MANUAL_COMPACT)
          if (prune === undefined) return { ok: true, text: 'nothing to compact' }
          yield* context.session.append('compaction/prune', prune).pipe(Effect.orDie)
          // The summary rides on the fold when the loop can ask for one; nothing it
          // cannot say leaves the prune to bound the request on its own.
          const checkpoint =
            options.compactNow === undefined ? undefined : yield* options.compactNow()
          if (checkpoint !== undefined) {
            yield* context.session.append('compaction/checkpoint', checkpoint).pipe(Effect.orDie)
          }
          return {
            ok: true,
            text:
              'compacted ' +
              String(prune.replacements.length) +
              ' messages, ' +
              String(prune.shadowedBytes) +
              ' bytes freed',
          }
        }),
    })
    yield* commands.register({
      name: 'feedback',
      summary: 'rate an answer like or dislike, with an optional short memo',
      run: (input, context) =>
        Effect.gen(function* () {
          const request = feedbackRequest(input)
          if (request === undefined) return { ok: false, text: FEEDBACK_USAGE }
          return yield* rateFeedback(context.session, request).pipe(
            Effect.map((rated) => ({
              ok: true,
              text:
                'rated #' +
                String(rated.target) +
                ' ' +
                rated.rating +
                (rated.memo === undefined ? '' : ': ' + rated.memo),
            })),
            Effect.catch((error) => Effect.succeed({ ok: false, text: error.message })),
          )
        }),
    })
    yield* commands.register({
      name: 'goal',
      summary: 'create a goal, or pause, resume, edit, and finish the one there is; alone reads it',
      run: (input, context) =>
        Effect.gen(function* () {
          const args = goalRequest(input)
          if (args === undefined) {
            return { ok: false, text: 'usage: /goal edit <objective>' }
          }
          return yield* runGoal(args, goalLogOf(context.session)).pipe(
            Effect.map((value) => ({ ok: true, text: goalText(value) })),
            Effect.catch((error) => Effect.succeed({ ok: false, text: error.message })),
          )
        }),
    })
    // Two commands with these names would be a mistake in this file, not a session's.
  }).pipe(Effect.orDie)
