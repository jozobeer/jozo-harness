import { describe, expect, test } from 'vitest'
import { METRIC_NAMES } from './metrics.ts'
import { TASKS } from './tasks.ts'

/**
 * The regime field is what keeps a flat A/B run readable: it says, before the run, where the
 * two harnesses would diverge on this task and what a tie then fails to tell apart. These
 * tests hold every task to that, so a task cannot be added with the field left unread.
 */

const names = [
  'fix-add',
  'write-notes',
  'rename-function',
  'fix-rules',
  'read-report',
  'long-prompt',
  'find-disagreement',
  'recover-ambiguous-edit',
]

describe('the A/B task list', () => {
  test('ships every task, in the order the sweep reads them', () => {
    expect(TASKS.map((task) => task.name)).toEqual(names)
  })

  test('every task says where a difference would show', () => {
    for (const task of TASKS) {
      expect(task.regime.difference.length, task.name).toBeGreaterThan(40)
      expect(task.regime.flat.length, task.name).toBeGreaterThan(40)
      expect(task.regime.difference, task.name).not.toBe(task.regime.flat)
    }
  })

  test('every difference is named on a counter the A/B actually keeps', () => {
    for (const task of TASKS) {
      const named = METRIC_NAMES.filter((metric) => task.regime.difference.includes(metric))
      expect(named.length, task.name + ': ' + task.regime.difference).toBeGreaterThan(0)
    }
  })
})
