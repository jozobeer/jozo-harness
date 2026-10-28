import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@jozo-harness/session'
import { describe, expect, test } from 'vitest'
import { makeScheduleStore, type Schedule } from '../src/index.ts'

const NOW = Date.parse('2026-10-14T09:00:00Z')

const schedule = (id: string, seconds: number, sessionId = 's1'): Schedule => ({
  id,
  sessionId,
  rule: { kind: 'every', seconds },
  prompt: 'do the thing',
  createdAt: NOW,
})

const withStore = async (body: (store: ReturnType<typeof makeScheduleStore>) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-schedules-'))
  try {
    await body(makeScheduleStore(join(root, 'schedules.json'), { now: () => NOW }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('the host schedule store', () => {
  test('writes, lists, and reads the file back', () =>
    withStore(async (store) => {
      store.write({ kind: 'created', schedule: schedule('sched-1', 60) })
      store.write({ kind: 'created', schedule: schedule('sched-2', 60, 's2') })

      expect(store.list().map((each) => each.id)).toEqual(['sched-1', 'sched-2'])
      expect(store.list('s2').map((each) => each.id)).toEqual(['sched-2'])
      expect(store.find('sched-1')?.prompt).toBe('do the thing')
      const reloaded = makeScheduleStore(store.path)
      expect(reloaded.list().map((each) => each.id)).toEqual(['sched-1', 'sched-2'])
      expect(JSON.parse(await readFile(store.path, 'utf8')).version).toBe(1)
    }))

  test('keeps ids unique across sessions', () =>
    withStore(async (store) => {
      store.write({ kind: 'created', schedule: schedule('sched-1', 60) })
      store.write({ kind: 'created', schedule: schedule('sched-2', 60, 's2') })
      expect(store.nextId()).toBe('sched-3')
    }))

  test('due skips paused schedules and orders by the next instant', () =>
    withStore(async (store) => {
      store.write({ kind: 'created', schedule: schedule('slow', 600) })
      store.write({ kind: 'created', schedule: schedule('quick', 10) })
      store.write({ kind: 'updated', schedule: { ...schedule('quick', 10), paused: true } })
      store.write({ kind: 'created', schedule: schedule('middle', 30) })
      store.write({ kind: 'fired', id: 'middle', at: NOW })

      expect(store.due(NOW + 5_000).map((each) => each.id)).toEqual([])
      expect(store.due(NOW + 40_000).map((each) => each.id)).toEqual(['middle'])
      expect(store.due(NOW + 700_000).map((each) => each.id)).toEqual(['middle', 'slow'])
    }))

  test('adopts the schedules an older session log recorded, once', () =>
    withStore(async (store) => {
      const schedule = (id: string): Schedule => ({
        id,
        rule: { kind: 'daily', time: '08:30' },
        prompt: 'legacy',
        createdAt: NOW,
      })
      const event = (type: string, data: unknown): SessionEvent =>
        ({ seq: 1, time: NOW, type, data }) as unknown as SessionEvent
      const events = [event('schedule/created', { schedule: schedule('old') })]

      const adopted = store.adoptLegacy('s1', events, 'Asia/Tokyo')

      expect(adopted).toHaveLength(1)
      expect(store.list('s1')).toMatchObject([
        { id: 'old', sessionId: 's1', rule: { timeZone: 'Asia/Tokyo' } },
      ])
      expect(store.adoptLegacy('s1', events, 'Asia/Tokyo')).toEqual([])
      expect(store.list()).toHaveLength(1)
    }))

  test('deletes a schedule and keeps the rest', () =>
    withStore(async (store) => {
      store.write({ kind: 'created', schedule: schedule('a', 60) })
      store.write({ kind: 'created', schedule: schedule('b', 60) })
      store.write({ kind: 'deleted', id: 'a' })
      expect(store.list().map((each) => each.id)).toEqual(['b'])
    }))

  test('a file it cannot read is refused instead of silently emptied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-schedules-'))
    const path = join(root, 'schedules.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ version: 2, schedules: [] }))
    expect(() => makeScheduleStore(path)).toThrow('version')
    await rm(root, { recursive: true, force: true })
  })
})
