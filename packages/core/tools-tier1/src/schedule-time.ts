/**
 * When a schedule comes around next. Everything here is a pure function of a
 * rule, a reference instant, and the last firing. A recurring rule reads its
 * wall clock in the IANA time zone it names, so the answer does not depend on
 * the process's own zone and stays right across a daylight-saving change.
 */

/** How a schedule repeats, or the one instant it names. */
export type ScheduleRule =
  | { readonly kind: 'every'; readonly seconds: number }
  | { readonly kind: 'daily'; readonly time: string; readonly timeZone?: string }
  | {
      readonly kind: 'weekly'
      readonly weekdays: ReadonlyArray<number>
      readonly time: string
      readonly timeZone?: string
    }
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone?: string }
  /** One instant, in epoch milliseconds. */
  | { readonly kind: 'at'; readonly at: number }
  /** One run this many seconds after the schedule was written. */
  | { readonly kind: 'after'; readonly seconds: number }

/** The days a four-year search looks through before it gives a rule up for dead. */
const MAX_DAYS = 1462

/** Which minutes, hours, month days, months, and weekdays a cron rule accepts. */
export interface CronFields {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly monthDays: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  /** JavaScript weekdays, 0 = Sunday. */
  readonly weekdays: ReadonlySet<number>
}

const FIELD_RANGES: ReadonlyArray<readonly [name: string, min: number, max: number]> = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
  ['day of week', 0, 7],
]

/** The first and last value one `*` or `a-b` part names. */
const boundsOf = (
  range: string,
  min: number,
  max: number,
  name: string,
): readonly [number, number] => {
  if (range === '*') return [min, max]
  const values = range.split('-').map((value) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error('bad ' + name + ' in a cron expression: ' + value)
    }
    return parsed
  })
  const first = values[0] ?? min
  const last = values.length === 1 ? first : (values[1] ?? max)
  if (last < first) throw new Error('backwards range in the ' + name + ' field')
  return [first, last]
}

/** Every value one comma-separated part of a cron field names. */
const numbersIn = (part: string, min: number, max: number, name: string): ReadonlyArray<number> => {
  const [range, stepText] = part.split('/')
  if (range === undefined) throw new Error('empty ' + name + ' in a cron expression')
  const step = stepText === undefined ? 1 : Number(stepText)
  if (!Number.isInteger(step) || step < 1) throw new Error('bad step in the ' + name + ' field')
  const [first, last] = boundsOf(range, min, max, name)
  const values: Array<number> = []
  for (let value = first; value <= last; value += step) values.push(value)
  return values
}

/** Parses one 5-field cron expression; a field that cannot happen is refused here. */
export const parseCron = (expression: string): CronFields => {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error('a cron expression has five fields: ' + expression)
  }
  const sets = fields.map((field, index) => {
    const [name, min, max] = FIELD_RANGES[index] ?? ['field', 0, 0]
    const values = field.split(',').flatMap((part) => numbersIn(part, min, max, name ?? 'field'))
    return new Set(values)
  })
  const weekdays = new Set([...(sets[4] ?? [])].map((day) => (day === 7 ? 0 : day)))
  return {
    minutes: sets[0] ?? new Set(),
    hours: sets[1] ?? new Set(),
    monthDays: sets[2] ?? new Set(),
    months: sets[3] ?? new Set(),
    weekdays,
  }
}

const isUnrestricted = (field: string): boolean => field.trim() === '*'

/** The zone the process itself runs in, used when a rule names none. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Whether the runtime knows this IANA name; a misspelling is refused where it is written. */
export const isValidTimeZone = (zone: string): boolean => {
  if (zone.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** A clock reading in one zone, with the fields a cron rule matches. */
interface Wall {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterOf = (zone: string): Intl.DateTimeFormat => {
  const known = formatters.get(zone)
  if (known !== undefined) return known
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  formatters.set(zone, made)
  return made
}

/** How one instant reads on the zone's own wall clock. */
const wallAt = (instant: number, zone: string): Wall => {
  const parts = formatterOf(zone).formatToParts(new Date(instant))
  const of = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: of('year'),
    month: of('month'),
    day: of('day'),
    hour: of('hour') % 24,
    minute: of('minute'),
    second: of('second'),
  }
}

/** The reading a wall clock would have if the zone were UTC. */
const wallAsUtc = (wall: Wall): number =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, 0)

const sameWall = (left: Wall, right: Wall): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.second === right.second

/**
 * The instant one wall reading names in the zone, or nothing when the zone skips
 * it (the hour a spring-forward deletes). Two candidate offsets are tried, because
 * an ambiguous reading in a fall-back hour has an earlier and a later instant; the
 * earlier one is the schedule's.
 */
const instantOfWall = (wall: Wall, zone: string): number | undefined => {
  const guess = wallAsUtc(wall)
  const candidates = new Set<number>()
  for (const delta of [-36, -12, 0, 12, 36]) {
    const sample = guess + delta * 3_600_000
    const offset = wallAsUtc(wallAt(sample, zone)) - sample
    candidates.add(guess - offset)
  }
  const valid = [...candidates]
    .filter((instant) => sameWall(wallAt(instant, zone), wall))
    .sort((left, right) => left - right)
  return valid[0]
}

/** A calendar date as a UTC-based Date, so adding days never touches a zone. */
const calendarDate = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day))

const dayMatches = (
  fields: CronFields,
  day: Date,
  domRestricted: boolean,
  dowRestricted: boolean,
): boolean => {
  if (!fields.months.has(day.getUTCMonth() + 1)) return false
  const dom = fields.monthDays.has(day.getUTCDate())
  const dow = fields.weekdays.has(day.getUTCDay())
  // cron: with both restricted, either may match; otherwise the restricted one decides.
  if (domRestricted && dowRestricted) return dom || dow
  if (domRestricted) return dom
  if (dowRestricted) return dow
  return true
}

const minutesOf = (fields: CronFields): ReadonlyArray<number> => {
  const hours = [...fields.hours].sort((left, right) => left - right)
  const minutes = [...fields.minutes].sort((left, right) => left - right)
  const all: Array<number> = []
  for (const hour of hours) {
    for (const minute of minutes) all.push(hour * 60 + minute)
  }
  return all
}

/**
 * The next minute on the zone's wall clock that matches the fields, strictly
 * after `base`. A reading the zone skips is passed over, and a rule whose fields
 * can never meet (30 February) has no answer.
 */
/** The first instant on one wall-clock day at or after `fromMinute` and after `base`. */
const minuteInstantsOn = (
  fields: CronFields,
  day: Date,
  fromMinute: number,
  zone: string,
  base: number,
): number | undefined => {
  for (const minute of minutesOf(fields)) {
    if (minute < fromMinute) continue
    const instant = instantOfWall(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: Math.floor(minute / 60),
        minute: minute % 60,
        second: 0,
      },
      zone,
    )
    if (instant !== undefined && instant > base) return instant
  }
  return undefined
}

const nextMatchingMinute = (
  fields: CronFields,
  base: number,
  zone: string,
  domRestricted: boolean,
  dowRestricted: boolean,
): number | undefined => {
  if (minutesOf(fields).length === 0) return undefined
  const start = wallAt(base, zone)
  const firstDay = calendarDate(start.year, start.month, start.day)
  const startMinute = start.hour * 60 + start.minute

  for (let offset = 0; offset < MAX_DAYS; offset += 1) {
    const day = new Date(
      Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth(), firstDay.getUTCDate() + offset),
    )
    if (!dayMatches(fields, day, domRestricted, dowRestricted)) continue
    const found = minuteInstantsOn(fields, day, offset === 0 ? startMinute : 0, zone, base)
    if (found !== undefined) return found
  }
  return undefined
}

const clockMinutes = (time: string): number => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (match === null) throw new Error('a time of day looks like 08:30: ' + time)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) throw new Error('a time of day is within one day: ' + time)
  return hours * 60 + minutes
}

const dailyFields = (minutesOfDay: number): CronFields => ({
  minutes: new Set([minutesOfDay % 60]),
  hours: new Set([Math.floor(minutesOfDay / 60)]),
  monthDays: new Set(),
  months: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  weekdays: new Set(),
})

/** Intervals count from the later of the schedule's creation and its last firing. */
const baseOf = (from: number, lastFired: number | undefined): number =>
  lastFired === undefined ? from : Math.max(from, lastFired)

const weeklyFields = (rule: {
  readonly weekdays: ReadonlyArray<number>
  readonly time: string
}): CronFields => {
  const weekdays = new Set(rule.weekdays.map((day) => (day === 7 ? 0 : day % 7)))
  return { ...dailyFields(clockMinutes(rule.time)), weekdays }
}

const nextCron = (expression: string, base: number, zone: string): number | undefined => {
  const parts = expression.trim().split(/\s+/)
  return nextMatchingMinute(
    parseCron(expression),
    base,
    zone,
    !isUnrestricted(parts[2] ?? '*'),
    !isUnrestricted(parts[4] ?? '*'),
  )
}

/** The zone a rule reads its wall clock in, or the process's own when it names none. */
export const zoneOf = (rule: ScheduleRule): string => {
  if (rule.kind === 'daily' || rule.kind === 'weekly' || rule.kind === 'cron') {
    return rule.timeZone ?? localTimeZone()
  }
  return localTimeZone()
}

/**
 * The instant a rule comes around next. A rule that never comes around, or a
 * one-time rule whose instant has already gone, has no answer.
 */
/** The next wall-clock reading of a rule that repeats. */
const recurringDue = (
  rule:
    | { readonly kind: 'daily'; readonly time: string; readonly timeZone?: string }
    | {
        readonly kind: 'weekly'
        readonly weekdays: ReadonlyArray<number>
        readonly time: string
        readonly timeZone?: string
      }
    | { readonly kind: 'cron'; readonly expression: string; readonly timeZone?: string },
  base: number,
): number | undefined => {
  const zone = zoneOf(rule)
  if (rule.kind === 'daily') {
    return nextMatchingMinute(dailyFields(clockMinutes(rule.time)), base, zone, false, false)
  }
  if (rule.kind === 'weekly') {
    return nextMatchingMinute(weeklyFields(rule), base, zone, false, true)
  }
  return nextCron(rule.expression, base, zone)
}

/**
 * The instant a rule comes around next. A rule that never comes around, or a
 * one-time rule whose instant has already gone, has no answer.
 */
export const nextDue = (
  rule: ScheduleRule,
  from: number,
  lastFired: number | undefined,
): number | undefined => {
  const base = baseOf(from, lastFired)
  if (rule.kind === 'every') return base + Math.max(rule.seconds, 1) * 1000
  if (rule.kind === 'at') return rule.at > from ? rule.at : undefined
  if (rule.kind === 'after') {
    return lastFired === undefined ? from + Math.max(rule.seconds, 1) * 1000 : undefined
  }
  return recurringDue(rule, base)
}
