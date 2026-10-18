import { Schema, Effect } from 'effect'
import type { SessionEvent } from '@jozo-harness/session'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { currentSchedules, RuleSchema, scheduleLine, type Schedule } from './schedule-state.ts'
import { nextDue, type ScheduleRule } from './schedule-time.ts'

const ACTIONS = ['create', 'list', 'update', 'delete'] as const

const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      'create adds a schedule, list shows the standing ones, update changes one, delete removes one.',
  }),
  id: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The schedule to change. Required with update and delete.',
    }),
  ),
  prompt: Schema.optionalKey(
    Schema.String.annotate({
      description: 'What to tell the model when the time arrives. Required with create.',
    }),
  ),
  title: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "A short name for lists, at most 120 characters: the action and its subject in the user's language, keeping identifiers such as PR numbers and branch names, without the frequency, dates, times, time zone, status, execution settings, or parenthetical notes.",
    }),
  ),
  every: Schema.optionalKey(
    Schema.Int.annotate({ description: 'Repeat every this many seconds.' }),
  ),
  daily: Schema.optionalKey(
    Schema.String.annotate({ description: "Repeat every day at this local time, like '08:30'." }),
  ),
  weekly: Schema.optionalKey(
    Schema.Struct({
      weekdays: Schema.Array(Schema.Int).annotate({
        description: 'ISO weekdays, 1 = Monday through 7 = Sunday.',
      }),
      time: Schema.String.annotate({ description: "The local time, like '08:30'." }),
    }).annotate({ description: 'Repeat on these weekdays at this local time.' }),
  ),
  cron: Schema.optionalKey(
    Schema.String.annotate({
      description: "A five-field cron expression, like '30 18 * * 1-5'.",
    }),
  ),
})

export type ScheduleArgs = Schema.Schema.Type<typeof Parameters>

/** What a schedule call leaves behind: the state of one, or of all of them. */
export interface ScheduleValue {
  readonly action: string
  readonly schedules: ReadonlyArray<Schedule>
}

/** Where schedules live: the session log, which is also what makes them durable. */
export interface ScheduleLog {
  readonly events: () => ReadonlyArray<SessionEvent>
  /** Records the newest state of one schedule. */
  readonly write: (event: ScheduleWrite) => Effect.Effect<void, ToolError>
  /** How the session names the schedule it is about to write. */
  readonly nextId: () => string
  /** The clock the schedule is created against. */
  readonly now: () => number
}

export type ScheduleWrite =
  | { readonly kind: 'created'; readonly schedule: Schedule }
  | { readonly kind: 'updated'; readonly schedule: Schedule }
  | { readonly kind: 'deleted'; readonly id: string }

const refuse = (message: string) => new ToolError({ code: 'invalid-arguments', message })

/** The one rule the arguments describe, or a refusal when they describe none or several. */
const ruleOf = (args: ScheduleArgs): ScheduleRule => {
  const named: Array<readonly [string, ScheduleRule]> = []
  if (args.every !== undefined) named.push(['every', { kind: 'every', seconds: args.every }])
  if (args.daily !== undefined) named.push(['daily', { kind: 'daily', time: args.daily }])
  if (args.weekly !== undefined) {
    named.push([
      'weekly',
      { kind: 'weekly', weekdays: args.weekly.weekdays, time: args.weekly.time },
    ])
  }
  if (args.cron !== undefined) named.push(['cron', { kind: 'cron', expression: args.cron }])
  const [first] = named
  if (first === undefined) {
    throw refuse('one of every, daily, weekly, or cron says when the schedule comes around')
  }
  if (named.length > 1) {
    throw refuse('name one of every, daily, weekly, or cron, not ' + String(named.length))
  }
  return first[1]
}

/** A rule that never comes around is refused where the model can still change it. */
const checkedRule = (rule: ScheduleRule, from: number): ScheduleRule => {
  if (nextDue(rule, from, undefined) === undefined) {
    throw refuse('this rule never comes around: ' + JSON.stringify(rule))
  }
  return rule
}

/** A title the lists can show: trimmed, non-empty, and no longer than dsh's 120 characters. */
const checkedTitle = (title: string | undefined): string | undefined => {
  if (title === undefined) return undefined
  const trimmed = title.trim()
  if (trimmed === '') throw refuse('title cannot be empty')
  if (trimmed.length > 120) throw refuse('title is at most 120 characters')
  return trimmed
}

const scheduleOf = (args: ScheduleArgs, log: ScheduleLog): Schedule => {
  const title = checkedTitle(args.title)
  return {
    id: log.nextId(),
    rule: checkedRule(ruleOf(args), log.now()),
    prompt: args.prompt ?? '',
    ...(title === undefined ? {} : { title }),
    createdAt: log.now(),
  }
}

const createSchedule = (args: ScheduleArgs, log: ScheduleLog) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    return Effect.fail(refuse('prompt is required to create a schedule'))
  }
  const schedule = scheduleOf(args, log)
  return log
    .write({ kind: 'created', schedule })
    .pipe(Effect.map(() => ({ action: 'create', schedules: [schedule] })))
}

const updateSchedule = (args: ScheduleArgs, log: ScheduleLog) => {
  const current = currentSchedules(log.events()).find((schedule) => schedule.id === args.id)
  if (current === undefined) {
    return Effect.fail(refuse('no schedule with that id: ' + String(args.id)))
  }
  const rule =
    args.every === undefined &&
    args.daily === undefined &&
    args.weekly === undefined &&
    args.cron === undefined
      ? current.rule
      : checkedRule(ruleOf(args), log.now())
  const title = checkedTitle(args.title)
  const schedule: Schedule = {
    ...current,
    rule,
    ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
    ...(title === undefined ? {} : { title }),
  }
  return log
    .write({ kind: 'updated', schedule })
    .pipe(Effect.map(() => ({ action: 'update', schedules: [schedule] })))
}

const deleteSchedule = (args: ScheduleArgs, log: ScheduleLog) => {
  const current = currentSchedules(log.events()).find((schedule) => schedule.id === args.id)
  if (current === undefined) {
    return Effect.fail(refuse('no schedule with that id: ' + String(args.id)))
  }
  return log
    .write({ kind: 'deleted', id: current.id })
    .pipe(Effect.map(() => ({ action: 'delete', schedules: [] })))
}

/** The line the model reads back: what happened, and what stands now. */
const renderValue = (value: ScheduleValue, events: ReadonlyArray<SessionEvent>): string => {
  if (value.action === 'list') {
    const standing = currentSchedules(events)
    return standing.length === 0
      ? '(no schedules)'
      : standing.map((schedule) => scheduleLine(schedule)).join('\n')
  }
  if (value.action === 'delete') return 'deleted the schedule'
  const [schedule] = value.schedules
  return schedule === undefined ? '(nothing changed)' : 'scheduled ' + scheduleLine(schedule)
}

/**
 * Records the standing instructions whose time brings the model back. Each call
 * writes one state to the log, so a resumed session still knows its schedules.
 */
export const makeScheduleTool = (
  log: ScheduleLog,
): ToolDefinition<ScheduleArgs, ScheduleValue> => ({
  name: 'schedule',
  description:
    'Keeps a standing instruction that brings this session back when its time arrives: create one with a rule and the prompt to deliver, and list, update, or delete the ones standing. Use it for work that should happen later or repeatedly.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      action: Schema.String,
      schedules: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          rule: RuleSchema,
          prompt: Schema.String,
          title: Schema.optionalKey(Schema.String),
          createdAt: Schema.Number,
        }),
      ),
    }),
    render: (_args, value) => [{ type: 'text', text: renderValue(value, log.events()) }],
  },
  execute: (args) => {
    try {
      if (args.action === 'create') return createSchedule(args, log)
      if (args.action === 'list') return Effect.succeed({ action: 'list', schedules: [] })
      if (args.action === 'update') return updateSchedule(args, log)
      return deleteSchedule(args, log)
    } catch (error) {
      return Effect.fail(error instanceof ToolError ? error : refuse(String(error)))
    }
  },
})
