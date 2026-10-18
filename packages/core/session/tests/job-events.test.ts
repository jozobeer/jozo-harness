import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { decodeSessionEvent, deriveMessages } from '../src/index.ts'
import { event, headerEvent } from './support.ts'

describe('job lifecycle events', () => {
  test('started and ended decode and add no message to the history', async () => {
    const started = event(2, 'job/started', {
      id: 'job-ab12cd34',
      command: 'sleep 5',
      cwd: '/work',
      startedAt: 100,
    })
    const ended = event(3, 'job/ended', {
      id: 'job-ab12cd34',
      endedAt: 200,
      status: 'exited',
      exitCode: 0,
    })

    const decoded = await Effect.runPromise(
      Effect.all([decodeSessionEvent(started), decodeSessionEvent(ended)]),
    )

    expect(decoded).toEqual([started, ended])
    expect(deriveMessages([headerEvent(), started, ended])).toEqual([])
  })

  test('an ended record keeps a kill apart from an exit', async () => {
    const ended = event(2, 'job/ended', {
      id: 'job-ab12cd34',
      endedAt: 200,
      status: 'killed',
    })

    await expect(Effect.runPromise(decodeSessionEvent(ended))).resolves.toEqual(ended)
  })

  test('a started record without a cwd is accepted', async () => {
    const started = event(2, 'job/started', {
      id: 'job-ab12cd34',
      command: 'sleep 5',
      startedAt: 100,
    })

    await expect(Effect.runPromise(decodeSessionEvent(started))).resolves.toEqual(started)
  })
})
