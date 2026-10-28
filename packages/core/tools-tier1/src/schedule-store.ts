import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SessionEvent } from '@jozo-harness/session'
import { currentSchedules, type Schedule } from './schedule-state.ts'
import { nextDue, type ScheduleRule } from './schedule-time.ts'

/** One change to the host's schedule file. */
export type ScheduleStoreWrite =
  | { readonly kind: 'created'; readonly schedule: Schedule }
  | { readonly kind: 'updated'; readonly schedule: Schedule }
  | { readonly kind: 'deleted'; readonly id: string }
  /** The host delivered the schedule at this instant. */
  | { readonly kind: 'fired'; readonly id: string; readonly at: number }

/** One version of the file. A newer version is refused rather than guessed at. */
interface ScheduleFile {
  readonly version: 1
  readonly schedules: ReadonlyArray<Schedule>
}

/**
 * The schedules of every session, in one file under the host's config directory.
 * A schedule carries the session that wrote it, so the clock that owns the file
 * can deliver it to that session whichever one a page is showing.
 */
export interface ScheduleStore {
  readonly path: string
  /** The standing schedules, newest last; one session's when it is named. */
  readonly list: (sessionId?: string) => ReadonlyArray<Schedule>
  readonly find: (id: string) => Schedule | undefined
  /** A new id, unique in the whole file, so two sessions cannot share one. */
  readonly nextId: () => string
  readonly now: () => number
  /** Applies one change and writes the file before it returns. */
  readonly write: (write: ScheduleStoreWrite) => void
  /** The schedules whose next instant has come, soonest first. */
  readonly due: (at: number) => ReadonlyArray<Schedule>
  /**
   * Adopts the schedules an older session log recorded, so a session that was
   * written before the host kept them still lists and fires them. Ids are kept,
   * and a schedule already in the file is left alone. The log stays readable as
   * the record of what happened; the file is what runs from now on.
   */
  readonly adoptLegacy: (
    sessionId: string,
    events: ReadonlyArray<SessionEvent>,
    timeZone?: string,
  ) => ReadonlyArray<Schedule>
}

const isSchedule = (value: unknown): value is Schedule => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.prompt === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.rule === 'object' &&
    record.rule !== null &&
    typeof (record.rule as Record<string, unknown>).kind === 'string'
  )
}

/** The file's schedules; a missing file is an empty host, a wrong one is refused. */
export const readScheduleFile = (path: string): ReadonlyArray<Schedule> => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the schedule file is not an object: ' + path)
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) {
    throw new Error('the schedule file has a version this build does not read: ' + path)
  }
  return Array.isArray(record.schedules) ? record.schedules.filter(isSchedule) : []
}

/** Writes the whole file through a temporary name, so a reader never sees half of it. */
const writeScheduleFile = (path: string, schedules: ReadonlyArray<Schedule>): void => {
  mkdirSync(dirname(path), { recursive: true })
  const file: ScheduleFile = { version: 1, schedules }
  const text = JSON.stringify(file, null, 2) + '\n'
  const temporary = path + '.tmp'
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/** The zone an older recurring rule should read when the log did not name one. */
const withZone = (rule: ScheduleRule, timeZone: string | undefined): ScheduleRule => {
  if (timeZone === undefined || timeZone === '') return rule
  if (rule.kind === 'daily' || rule.kind === 'weekly' || rule.kind === 'cron') {
    return rule.timeZone === undefined ? { ...rule, timeZone } : rule
  }
  return rule
}

/**
 * Opens the host's schedule file. One process owns one file; two servers pointed
 * at the same path would each keep their own copy, so the caller passes the same
 * path to every session of one server and runs one web server per host.
 */
export const makeScheduleStore = (
  path: string,
  options?: { readonly now?: () => number },
): ScheduleStore => {
  const now = options?.now ?? Date.now
  let schedules: ReadonlyArray<Schedule> = readScheduleFile(path)

  const persist = (next: ReadonlyArray<Schedule>): void => {
    writeScheduleFile(path, next)
    schedules = next
  }

  const store: ScheduleStore = {
    path,
    now,
    list: (sessionId) =>
      schedules.filter((schedule) => sessionId === undefined || schedule.sessionId === sessionId),
    find: (id) => schedules.find((schedule) => schedule.id === id),
    nextId: () => {
      let number = schedules.length + 1
      const taken = new Set(schedules.map((schedule) => schedule.id))
      while (taken.has('sched-' + String(number))) number += 1
      return 'sched-' + String(number)
    },
    write: (write) => {
      if (write.kind === 'deleted') {
        persist(schedules.filter((schedule) => schedule.id !== write.id))
        return
      }
      if (write.kind === 'fired') {
        persist(
          schedules.map((schedule) =>
            schedule.id === write.id ? { ...schedule, lastFiredAt: write.at } : schedule,
          ),
        )
        return
      }
      const exists = schedules.some((schedule) => schedule.id === write.schedule.id)
      persist(
        exists
          ? schedules.map((schedule) =>
              schedule.id === write.schedule.id ? write.schedule : schedule,
            )
          : [...schedules, write.schedule],
      )
    },
    due: (at) =>
      schedules
        .flatMap((schedule) => {
          if (schedule.paused === true) return []
          const next = nextDue(schedule.rule, schedule.createdAt, schedule.lastFiredAt)
          return next !== undefined && next <= at ? [{ schedule, next }] : []
        })
        .sort((left, right) => left.next - right.next)
        .map((entry) => entry.schedule),
    adoptLegacy: (sessionId, events, timeZone) => {
      const taken = new Set(schedules.map((schedule) => schedule.id))
      const adopted: Array<Schedule> = []
      for (const legacy of currentSchedules(events)) {
        if (taken.has(legacy.id)) continue
        taken.add(legacy.id)
        adopted.push({
          ...legacy,
          sessionId,
          rule: withZone(legacy.rule, timeZone),
        })
      }
      if (adopted.length > 0) persist([...schedules, ...adopted])
      return adopted
    },
  }
  return store
}
