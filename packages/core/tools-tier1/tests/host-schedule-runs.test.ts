import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { fireDueSchedules, makeScheduleStore, type Schedule } from '../src/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = Date.parse('2026-10-14T09:00:00Z')

const schedule = (id: string, sessionId: string, createdAt = NOW - 65_000): Schedule => ({
  id,
  sessionId,
  rule: { kind: 'every', seconds: 60 },
  prompt: 'do the thing',
  createdAt,
})

describe('the host clock', () => {
  test('delivers each due schedule to the session that wrote it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-clock-'))
    const store = makeScheduleStore(join(root, 'schedules.json'), { now: () => NOW })
    store.write({ kind: 'created', schedule: schedule('one', 's1') })
    store.write({ kind: 'created', schedule: schedule('two', 's2') })
    const asked: Array<string> = []

    await Effect.runPromise(
      fireDueSchedules(
        {
          store,
          deliver: (each) =>
            Effect.sync(() => {
              asked.push(each.id)
              return each.sessionId === 's1'
            }),
          now: () => NOW,
        },
        NOW,
      ),
    )

    expect(asked.sort()).toEqual(['one', 'two'])
    expect(store.find('one')?.lastFiredAt).toBe(NOW)
    // The session nobody could reach stays due, so opening it later catches up.
    expect(store.find('two')?.lastFiredAt).toBeUndefined()
    expect(store.due(NOW).map((each) => each.id)).toEqual(['two'])
    await rm(root, { recursive: true, force: true })
  })

  test('delivers a schedule another session wrote, not the page the reader sees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-clock-'))
    const store = makeScheduleStore(join(root, 'schedules.json'), { now: () => NOW })
    store.write({ kind: 'created', schedule: schedule('elsewhere', 's2') })
    const sent: Array<readonly [string, string]> = []

    await Effect.runPromise(
      fireDueSchedules(
        {
          store,
          deliver: (each) =>
            Effect.sync(() => {
              sent.push([each.id, each.sessionId ?? ''])
              return true
            }),
          now: () => NOW,
        },
        NOW,
      ),
    )

    expect(sent).toEqual([['elsewhere', 's2']])
    await rm(root, { recursive: true, force: true })
  })
})
