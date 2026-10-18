import { Effect } from 'effect'
import {
  commandHelp,
  cwdOf,
  type CommandsShape,
  type Session,
  type SessionHeader,
} from '@jozo-harness/session'
import {
  currentGoal,
  currentSchedules,
  goalRounds,
  goalText,
  ruleText,
  runGoal,
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
    ...schedules.map((schedule) => '  ' + schedule.id + ' ' + ruleText(schedule.rule)),
  ]
}

/** What /status answers: everything a session can say about itself from its log. */
export const statusText = (session: Session): string => {
  const events = session.events()
  const header: SessionHeader = session.header
  return [
    'session: ' + session.id,
    'model: ' + modelOf(session),
    'cwd: ' + cwdOf(events, header),
    'turns: ' + String(events.filter((event) => event.type === 'turn/start').length),
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

/** The words that move an existing goal rather than name a new objective. */
const GOAL_PHASE_WORDS: Readonly<Record<string, GoalArgs['action']>> = {
  pause: 'pause',
  resume: 'resume',
  done: 'complete',
}

/** The session's log as the goal tool writes it; a lost write is a bug, not an answer. */
const goalLogOf = (session: Session): GoalLog => ({
  events: () => session.events(),
  append: (state) => session.append('goal/updated', state).pipe(Effect.orDie),
})

/** The commands every jozo-harness session answers. */
export const installBuiltinCommands = (commands: CommandsShape): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* commands.register({
      name: 'help',
      summary: 'list the commands this session answers',
      run: () => Effect.succeed({ ok: true, text: commandHelp(commands.list()) }),
    })
    yield* commands.register({
      name: 'status',
      summary: 'where this session stands: model, cwd, turns, goal, schedules',
      run: (_input, context) => Effect.succeed({ ok: true, text: statusText(context.session) }),
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
