import { Schema } from 'effect'
import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type SessionEvent,
  type SessionEventSchemaMap,
} from '@jozo-harness/session'
import type { ScheduleRule } from './schedule-time.ts'

/** One standing instruction: when it comes around, the model is told to do this. */
export interface Schedule {
  readonly id: string
  readonly rule: ScheduleRule
  /** What to tell the model when the time arrives. */
  readonly prompt: string
  /** A short name for the list; older schedules have none and fall back to the prompt. */
  readonly title?: string
  /** When the schedule was written, which is where an interval counts from. */
  readonly createdAt: number
}

/** The source of the message the driver sends when a schedule comes due. */
export const SCHEDULE_SOURCE = 'schedule'

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'schedule/created': { readonly schedule: Schedule }
    'schedule/updated': { readonly schedule: Schedule }
    'schedule/deleted': { readonly id: string }
    'schedule/fired': { readonly id: string; readonly at: number }
  }
}

/** The rule shapes a schedule accepts, as the model sees them in a schema. */
export const RuleSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(['every']), seconds: Schema.Int }),
  Schema.Struct({ kind: Schema.Literals(['daily']), time: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals(['weekly']),
    weekdays: Schema.Array(Schema.Int),
    time: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literals(['cron']), expression: Schema.String }),
])

const ScheduleSchema = Schema.Struct({
  id: Schema.String,
  rule: RuleSchema,
  prompt: Schema.String,
  title: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
})

/** Schemas for the session events this module adds. */
export const scheduleEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  ['schedule/created', Schema.Struct({ schedule: ScheduleSchema })],
  ['schedule/updated', Schema.Struct({ schedule: ScheduleSchema })],
  ['schedule/deleted', Schema.Struct({ id: Schema.String })],
  ['schedule/fired', Schema.Struct({ id: Schema.String, at: Schema.Number })],
])

registerSessionEventSchemas(scheduleEventSchemas)
// Schedules are for the driver and the UI; the model reads them from the tool result.
registerLogOnlySessionEvents([
  'schedule/created',
  'schedule/updated',
  'schedule/deleted',
  'schedule/fired',
])

/** The schedules the log still holds, in the order they were created. */
export const currentSchedules = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<Schedule> => {
  const byId = new Map<string, Schedule>()
  for (const event of events) {
    if (event.type === 'schedule/created' || event.type === 'schedule/updated') {
      byId.set(event.data.schedule.id, event.data.schedule)
    } else if (event.type === 'schedule/deleted') {
      byId.delete(event.data.id)
    }
  }
  return [...byId.values()]
}

/** When this schedule last fired, which is what an interval counts from. */
export const lastFiredAt = (
  events: ReadonlyArray<SessionEvent>,
  id: string,
): number | undefined => {
  let last: number | undefined
  for (const event of events) {
    if (event.type !== 'schedule/fired' || event.data.id !== id) continue
    if (last === undefined || event.data.at > last) last = event.data.at
  }
  return last
}

/** How a rule reads to the model: short, and the same everywhere it is shown. */
export const ruleText = (rule: ScheduleRule): string => {
  if (rule.kind === 'every') return 'every ' + String(rule.seconds) + 's'
  if (rule.kind === 'daily') return 'daily at ' + rule.time
  if (rule.kind === 'weekly') return 'weekly on ' + rule.weekdays.join(',') + ' at ' + rule.time
  return 'cron ' + rule.expression
}

/** The shortest name a schedule carries: its title, or the prompt's first line for older ones. */
export const scheduleTitle = (schedule: Schedule): string => {
  if (schedule.title !== undefined && schedule.title !== '') return schedule.title
  const [first = ''] = schedule.prompt.split('\n')
  return first
}

/** How a schedule reads in a list. */
export const scheduleLine = (schedule: Schedule): string =>
  schedule.id + ' ' + ruleText(schedule.rule) + ' -> ' + scheduleTitle(schedule)

/** The message the driver sends when a schedule comes due. */
export const renderSchedulePrompt = (schedule: Schedule): string =>
  '<schedule id="' +
  schedule.id +
  '" rule="' +
  ruleText(schedule.rule) +
  '">\n' +
  schedule.prompt +
  '\n</schedule>'
