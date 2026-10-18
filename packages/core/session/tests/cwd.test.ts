import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { cwdOf, decodeSessionEvent, rootOf } from '../src/index.ts'

const header = { formatVersion: 1, createdAt: 0, cwd: '/start' }

describe('cwdOf', () => {
  test('falls back to the header', () => {
    expect(cwdOf([], header)).toBe('/start')
  })

  test('takes the newest change', () => {
    const events = [
      { seq: 2, time: 1, type: 'session/cwd/changed', data: { cwd: '/one' } },
      { seq: 3, time: 2, type: 'session/cwd/changed', data: { cwd: '/two' } },
    ] as const

    expect(cwdOf([...events], header)).toBe('/two')
  })

  test('a change that names a new root is where relative paths start', () => {
    const events = [
      { seq: 2, time: 1, type: 'session/cwd/changed', data: { cwd: '/one', root: '/tree' } },
      { seq: 3, time: 2, type: 'session/cwd/changed', data: { cwd: '/two' } },
    ] as const

    expect(rootOf([...events], header)).toBe('/tree')
    expect(cwdOf([...events], header)).toBe('/two')
  })

  test('the root falls back to the header', () => {
    expect(rootOf([], header)).toBe('/start')
  })

  test('the event decodes from the log', async () => {
    const event = await Effect.runPromise(
      decodeSessionEvent({
        seq: 5,
        time: 3,
        type: 'session/cwd/changed',
        data: { cwd: '/elsewhere', root: '/tree' },
      }),
    )

    expect(event?.type).toBe('session/cwd/changed')
    expect(event?.data).toEqual({ cwd: '/elsewhere', root: '/tree' })
  })
})
