import { Schema, Effect } from 'effect'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { ScheduleSchema, scheduleLine, type Schedule } from './schedule-state.ts'
import { isValidTimeZone, nextDue, type ScheduleRule } from './schedule-time.ts'

const ACTIONS = ['create', 'list', 'update', 'pause', 'resume', 'delete'] as const

const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      'create adds a schedule, list shows the standing ones, update changes one, pause stops one without forgetting it, resume starts it again, and delete removes one.',
  }),
  id: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The schedule to change. Required with update, pause, resume, and delete.',
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
  timeZone: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The IANA zone a daily, weekly, or cron wall clock reads, like 'Asia/Tokyo'. Defaults to this host's own zone.",
    }),
  ),
  at: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "One absolute instant as ISO 8601 with an offset, like '2026-10-30T09:00:00+09:00'. A time that has passed is refused.",
    }),
  ),
  after: Schema.optionalKey(
    Schema.Int.annotate({ description: 'One run this many seconds from now. Must be positive.' }),
  ),
  paused: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: 'With update, true stops the schedule and false starts it again.',
    }),
  ),
})

export type ScheduleArgs = Schema.Schema.Type<typeof Parameters>

/** What a schedule call leaves behind: the state of one, or of all of them. */
export interface ScheduleValue {
  readonly action: string
  readonly schedules: ReadonlyArray<Schedule>
}

/** Where this session's schedules live: the host store, shared with the web page. */
export interface ScheduleHost {
  /** The session a created schedule delivers to. */
  readonly sessionId: string
  /** The standing schedules of this session, as the host holds them now. */
  readonly list: () => ReadonlyArray<Schedule>
  /** Applies one change to the host store. */
  readonly write: (write: ScheduleWrite) => Effect.Effect<void, ToolError>
  /** A new id, unique in the host's file rather than only in this session. */
  readonly nextId: () => string
  readonly now: () => number
}

export type ScheduleWrite =
  | { readonly kind: 'created'; readonly schedule: Schedule }
  | { readonly kind: 'updated'; readonly schedule: Schedule }
  | { readonly kind: 'deleted'; readonly id: string }

const refuse = (message: string) => new ToolError({ code: 'invalid-arguments', message })

const recurring = (args: ScheduleRuleArgs): boolean =>
  args.daily !== undefined || args.weekly !== undefined || args.cron !== undefined

/** The rule arguments a model call and a page share, so both refuse the same ones. */
export interface ScheduleRuleArgs {
  readonly every?: number
  readonly daily?: string
  readonly weekly?: { readonly weekdays: ReadonlyArray<number>; readonly time: string }
  readonly cron?: string
  readonly timeZone?: string
  readonly at?: string
  readonly after?: number
}

/** The one rule the arguments describe, or a refusal when they describe none or several. */
const ruleOf = (args: ScheduleRuleArgs): ScheduleRule => {
  if (args.timeZone !== undefined && args.timeZone.trim() === '') {
    throw refuse('timeZone is empty')
  }
  if (args.timeZone !== undefined && !isValidTimeZone(args.timeZone)) {
    throw refuse('timeZone is not an IANA zone: ' + args.timeZone)
  }
  const zone = args.timeZone
  if (zone !== undefined && !recurring(args)) {
    throw refuse('timeZone goes with daily, weekly, or cron, not with every, at, or after')
  }
  const named: Array<readonly [string, ScheduleRule]> = []
  if (args.every !== undefined) named.push(['every', { kind: 'every', seconds: args.every }])
  if (args.daily !== undefined) {
    named.push([
      'daily',
      { kind: 'daily', time: args.daily, ...(zone === undefined ? {} : { timeZone: zone }) },
    ])
  }
  if (args.weekly !== undefined) {
    named.push([
      'weekly',
      {
        kind: 'weekly',
        weekdays: args.weekly.weekdays,
        time: args.weekly.time,
        ...(zone === undefined ? {} : { timeZone: zone }),
      },
    ])
  }
  if (args.cron !== undefined) {
    named.push([
      'cron',
      {
        kind: 'cron',
        expression: args.cron,
        ...(zone === undefined ? {} : { timeZone: zone }),
      },
    ])
  }
  if (args.at !== undefined) {
    const instant = Date.parse(args.at)
    if (Number.isNaN(instant)) throw refuse('at is not a date with an offset: ' + args.at)
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(args.at.trim())) {
      throw refuse('at needs an offset, like 2026-10-30T09:00:00+09:00')
    }
    named.push(['at', { kind: 'at', at: instant }])
  }
  if (args.after !== undefined) named.push(['after', { kind: 'after', seconds: args.after }])
  const [first] = named
  if (first === undefined) {
    throw refuse(
      'one of every, daily, weekly, cron, at, or after says when the schedule comes around',
    )
  }
  if (named.length > 1) {
    throw refuse(
      'name one of every, daily, weekly, cron, at, or after, not ' + String(named.length),
    )
  }
  return first[1]
}

/** A rule that never comes around is refused where the model can still change it. */
export const scheduleRuleOf = (args: ScheduleRuleArgs, from: number): ScheduleRule =>
  checkedRule(ruleOf(args), from)

const checkedRule = (rule: ScheduleRule, from: number): ScheduleRule => {
  if (nextDue(rule, from, undefined) === undefined) {
    throw refuse(
      rule.kind === 'at'
        ? 'at is already in the past'
        : 'this rule never comes around: ' + JSON.stringify(rule),
    )
  }
  return rule
}

/** A title the lists can show: trimmed, non-empty, and no longer than dsh's 120 characters. */
export const scheduleTitleOf = (title: string | undefined): string | undefined => {
  if (title === undefined) return undefined
  const trimmed = title.trim()
  if (trimmed === '') throw refuse('title cannot be empty')
  if (trimmed.length > 120) throw refuse('title is at most 120 characters')
  return trimmed
}

const scheduleOf = (args: ScheduleArgs, host: ScheduleHost): Schedule => {
  const title = scheduleTitleOf(args.title)
  const now = host.now()
  return {
    id: host.nextId(),
    sessionId: host.sessionId,
    rule: scheduleRuleOf(args, now),
    prompt: args.prompt ?? '',
    ...(title === undefined ? {} : { title }),
    createdAt: now,
  }
}

const createSchedule = (args: ScheduleArgs, host: ScheduleHost) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    return Effect.fail(refuse('prompt is required to create a schedule'))
  }
  try {
    const schedule = scheduleOf(args, host)
    return host
      .write({ kind: 'created', schedule })
      .pipe(Effect.map(() => ({ action: 'create', schedules: [schedule] })))
  } catch (error) {
    return Effect.fail(error instanceof ToolError ? error : refuse(String(error)))
  }
}

const updateSchedule = (args: ScheduleArgs, host: ScheduleHost) => {
  const current = host.list().find((schedule) => schedule.id === args.id)
  if (current === undefined) {
    return Effect.fail(refuse('no schedule with that id: ' + String(args.id)))
  }
  const namesRule =
    args.every !== undefined ||
    args.daily !== undefined ||
    args.weekly !== undefined ||
    args.cron !== undefined ||
    args.at !== undefined ||
    args.after !== undefined
  try {
    const rule = namesRule ? scheduleRuleOf(args, host.now()) : current.rule
    const title = scheduleTitleOf(args.title)
    const schedule: Schedule = {
      ...current,
      rule,
      ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
      ...(title === undefined ? {} : { title }),
      ...(args.paused === undefined ? {} : { paused: args.paused }),
    }
    return host
      .write({ kind: 'updated', schedule })
      .pipe(Effect.map(() => ({ action: 'update', schedules: [schedule] })))
  } catch (error) {
    return Effect.fail(error instanceof ToolError ? error : refuse(String(error)))
  }
}

const setPaused = (args: ScheduleArgs, host: ScheduleHost, paused: boolean) => {
  const current = host.list().find((schedule) => schedule.id === args.id)
  if (current === undefined) {
    return Effect.fail(refuse('no schedule with that id: ' + String(args.id)))
  }
  const schedule: Schedule = { ...current, paused }
  return host
    .write({ kind: 'updated', schedule })
    .pipe(Effect.map(() => ({ action: paused ? 'pause' : 'resume', schedules: [schedule] })))
}

const deleteSchedule = (args: ScheduleArgs, host: ScheduleHost) => {
  const current = host.list().find((schedule) => schedule.id === args.id)
  if (current === undefined) {
    return Effect.fail(refuse('no schedule with that id: ' + String(args.id)))
  }
  return host
    .write({ kind: 'deleted', id: current.id })
    .pipe(Effect.map(() => ({ action: 'delete', schedules: [] })))
}

/** The line the model reads back: what happened, and what stands now. */
const renderValue = (value: ScheduleValue, host: ScheduleHost): string => {
  if (value.action === 'list') {
    const standing = host.list()
    return standing.length === 0
      ? '(no schedules)'
      : standing.map((schedule) => scheduleLine(schedule)).join('\n')
  }
  if (value.action === 'delete') return 'deleted the schedule'
  const [schedule] = value.schedules
  if (schedule === undefined) return '(nothing changed)'
  if (value.action === 'pause') return 'paused ' + scheduleLine(schedule)
  if (value.action === 'resume') return 'resumed ' + scheduleLine(schedule)
  return 'scheduled ' + scheduleLine(schedule)
}

/**
 * Records a standing instruction whose time brings the model back. The host
 * store is what runs, so the model and the web page see and change one set.
 */
export const makeScheduleTool = (
  host: ScheduleHost,
): ToolDefinition<ScheduleArgs, ScheduleValue> => ({
  name: 'schedule',
  description:
    'Keeps a standing instruction that brings this session back when its time arrives: create one with a rule and the prompt to deliver, and list, update, pause, resume, or delete the ones standing. A rule reads its wall clock in the IANA zone it names. Use it for work that should happen later or repeatedly.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      action: Schema.String,
      schedules: Schema.Array(ScheduleSchema),
    }),
    render: (_args, value) => [{ type: 'text', text: renderValue(value, host) }],
  },
  execute: (args) => {
    try {
      if (args.action === 'create') return createSchedule(args, host)
      if (args.action === 'list') return Effect.succeed({ action: 'list', schedules: [] })
      if (args.action === 'pause') return setPaused(args, host, true)
      if (args.action === 'resume') return setPaused(args, host, false)
      if (args.action === 'update') return updateSchedule(args, host)
      return deleteSchedule(args, host)
    } catch (error) {
      return Effect.fail(error instanceof ToolError ? error : refuse(String(error)))
    }
  },
})
