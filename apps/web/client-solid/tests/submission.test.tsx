import { describe, expect, test } from 'vitest'
import { acceleratedSend, busyEnterFrom, oppositeMode, submitModeFor } from '../submission.ts'

describe('how a busy composer sends', () => {
  test('a page with no kept choice queues, as the core defaults', () => {
    expect(busyEnterFrom(null)).toBe('queue')
    expect(busyEnterFrom('queue')).toBe('queue')
    expect(busyEnterFrom('steer')).toBe('steer')
    // A stored word this build does not know is no reason to lose the default.
    expect(busyEnterFrom('later')).toBe('queue')
  })

  test('the accelerated gesture asks for the other mode', () => {
    expect(acceleratedSend({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(acceleratedSend({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(acceleratedSend({ metaKey: false, ctrlKey: false })).toBe(false)
    expect(oppositeMode('queue')).toBe('steer')
    expect(oppositeMode('steer')).toBe('queue')
  })

  test('a running turn takes the preferred mode, and an idle page always queues', () => {
    expect(submitModeFor('queue', true, false)).toBe('queue')
    expect(submitModeFor('steer', true, false)).toBe('steer')
    expect(submitModeFor('queue', true, true)).toBe('steer')
    expect(submitModeFor('steer', true, true)).toBe('queue')
    // Nothing runs, so there is no next step to join; queue starts the turn either way.
    expect(submitModeFor('steer', false, false)).toBe('queue')
    expect(submitModeFor('steer', false, true)).toBe('queue')
  })
})
