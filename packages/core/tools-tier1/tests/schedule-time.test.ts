import { describe, expect, test } from 'vitest'
import { isValidTimeZone, nextDue, parseCron } from '../src/index.ts'

/** A local instant, so the tests speak in the same clock the schedules do. */
const at = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number => new Date(year, month - 1, day, hour, minute, second, 0).getTime()

const local = (ms: number | undefined): string => {
  if (ms === undefined) return 'never'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds())
  )
}

describe('every', () => {
  test('comes around again after the interval', () => {
    const from = at(2026, 10, 14, 9, 0, 0)

    expect(nextDue({ kind: 'every', seconds: 90 }, from, undefined)).toBe(from + 90_000)
  })

  test('counts from the last firing, not from the clock', () => {
    const from = at(2026, 10, 14, 9, 0, 0)
    const fired = at(2026, 10, 14, 9, 0, 30)

    expect(nextDue({ kind: 'every', seconds: 60 }, from, fired)).toBe(fired + 60_000)
  })
})

describe('daily', () => {
  test('is the next time that clock reading comes around', () => {
    const from = at(2026, 10, 14, 9, 0, 0)

    expect(local(nextDue({ kind: 'daily', time: '18:30' }, from, undefined))).toBe(
      '2026-10-14 18:30:00',
    )
    expect(local(nextDue({ kind: 'daily', time: '08:00' }, from, undefined))).toBe(
      '2026-10-15 08:00:00',
    )
  })

  test('a time that has just passed waits for tomorrow', () => {
    const from = at(2026, 10, 14, 18, 30, 0)

    expect(local(nextDue({ kind: 'daily', time: '18:30' }, from, undefined))).toBe(
      '2026-10-15 18:30:00',
    )
  })
})

describe('weekly', () => {
  test('lands on the next named weekday', () => {
    // 2026-10-14 is a Wednesday.
    const from = at(2026, 10, 14, 9, 0, 0)

    expect(local(nextDue({ kind: 'weekly', weekdays: [1], time: '07:00' }, from, undefined))).toBe(
      '2026-10-19 07:00:00',
    )
    // The same weekday, later today, is still ahead.
    expect(local(nextDue({ kind: 'weekly', weekdays: [3], time: '10:00' }, from, undefined))).toBe(
      '2026-10-14 10:00:00',
    )
    expect(local(nextDue({ kind: 'weekly', weekdays: [3], time: '08:00' }, from, undefined))).toBe(
      '2026-10-21 08:00:00',
    )
  })
})

describe('cron', () => {
  test('every minute', () => {
    const from = at(2026, 10, 14, 9, 0, 30)

    expect(local(nextDue({ kind: 'cron', expression: '* * * * *' }, from, undefined))).toBe(
      '2026-10-14 09:01:00',
    )
  })

  test('a fixed time, a step, and a list', () => {
    const from = at(2026, 10, 14, 9, 0, 0)

    expect(local(nextDue({ kind: 'cron', expression: '30 18 * * *' }, from, undefined))).toBe(
      '2026-10-14 18:30:00',
    )
    expect(local(nextDue({ kind: 'cron', expression: '*/15 * * * *' }, from, undefined))).toBe(
      '2026-10-14 09:15:00',
    )
    expect(local(nextDue({ kind: 'cron', expression: '0 9,17 * * *' }, from, undefined))).toBe(
      '2026-10-14 17:00:00',
    )
  })

  test('ranges, weekdays, and month days', () => {
    const from = at(2026, 10, 14, 9, 0, 0)

    expect(local(nextDue({ kind: 'cron', expression: '0 9-11 * * 1-5' }, from, undefined))).toBe(
      '2026-10-14 10:00:00',
    )
    // Day 20 of this month, at the top of the day.
    expect(local(nextDue({ kind: 'cron', expression: '0 0 20 * *' }, from, undefined))).toBe(
      '2026-10-20 00:00:00',
    )
  })

  test('a weekday field is the weekday field', () => {
    // 2026-10-14 is a Wednesday, so the next Sunday is the 18th.
    const from = at(2026, 10, 14, 9, 0, 0)

    expect(local(nextDue({ kind: 'cron', expression: '0 0 * * 0' }, from, undefined))).toBe(
      '2026-10-18 00:00:00',
    )
    expect(local(nextDue({ kind: 'cron', expression: '0 0 * * 3' }, from, undefined))).toBe(
      '2026-10-21 00:00:00',
    )
  })

  test('a field that cannot happen is refused', () => {
    expect(() => parseCron('61 * * * *')).toThrow()
    expect(() => parseCron('* * * *')).toThrow()
    expect(() => parseCron('* * * * * *')).toThrow()
    expect(() => parseCron('* * 32 * *')).toThrow()
  })
})
describe('time zones', () => {
  const utc = (text: string): number => Date.parse(text)
  const iso = (ms: number | undefined): string =>
    ms === undefined ? 'never' : new Date(ms).toISOString()

  test('reads a daily time on the named zone, not the process clock', () => {
    const rule = { kind: 'daily', time: '08:30', timeZone: 'Asia/Tokyo' } as const

    // 2026-10-14T00:00Z is 09:00 in Tokyo, so that day's 08:30 has gone.
    expect(iso(nextDue(rule, utc('2026-10-14T00:00:00Z'), undefined))).toBe(
      '2026-10-14T23:30:00.000Z',
    )
    expect(iso(nextDue(rule, utc('2026-10-13T00:00:00Z'), undefined))).toBe(
      '2026-10-13T23:30:00.000Z',
    )
  })

  test('keeps the wall clock across a spring-forward change', () => {
    const rule = { kind: 'daily', time: '08:30', timeZone: 'America/New_York' } as const

    // DST begins on 2026-03-08 at 02:00; 08:30 is 12:30 UTC, not 13:30.
    expect(iso(nextDue(rule, utc('2026-03-07T14:00:00Z'), undefined))).toBe(
      '2026-03-08T12:30:00.000Z',
    )
  })

  test('keeps the wall clock across a fall-back change', () => {
    const rule = { kind: 'daily', time: '08:30', timeZone: 'America/New_York' } as const

    // DST ends on 2026-11-01 at 02:00; 08:30 is 13:30 UTC, not 12:30.
    expect(iso(nextDue(rule, utc('2026-10-31T14:00:00Z'), undefined))).toBe(
      '2026-11-01T13:30:00.000Z',
    )
  })

  test('passes over an hour the zone deletes', () => {
    const rule = { kind: 'cron', expression: '30 2 * * *', timeZone: 'America/New_York' } as const

    // 02:30 does not exist on 2026-03-08, so the next one is on the 9th.
    expect(iso(nextDue(rule, utc('2026-03-07T12:00:00Z'), undefined))).toBe(
      '2026-03-09T06:30:00.000Z',
    )
  })

  test('a weekly rule uses the named zone weekday', () => {
    const rule = {
      kind: 'weekly',
      weekdays: [0],
      time: '00:30',
      timeZone: 'Pacific/Auckland',
    } as const

    // 2026-10-17T00:00Z is Sunday 13:00 in Auckland; the next Sunday 00:30 is
    // 2026-10-18T00:30 +13:00 = 2026-10-17T11:30Z.
    expect(iso(nextDue(rule, utc('2026-10-17T00:00:00Z'), undefined))).toBe(
      '2026-10-17T11:30:00.000Z',
    )
  })

  test('knows which zone names it can read', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('one-time rules', () => {
  test('at names one instant, and only while it is still ahead', () => {
    const at = Date.parse('2026-10-14T18:30:00Z')

    expect(nextDue({ kind: 'at', at }, at - 1000, undefined)).toBe(at)
    expect(nextDue({ kind: 'at', at }, at, undefined)).toBeUndefined()
  })

  test('after counts from the time the schedule was written', () => {
    const from = Date.parse('2026-10-14T09:00:00Z')

    expect(nextDue({ kind: 'after', seconds: 90 }, from, undefined)).toBe(from + 90_000)
    expect(nextDue({ kind: 'after', seconds: 90 }, from, from + 90_000)).toBeUndefined()
  })
})
