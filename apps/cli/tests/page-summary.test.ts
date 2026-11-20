import type { SessionEvent, SessionHeader } from '@jozo-harness/session'
import { describe, expect, test } from 'vitest'
import { pageSummary } from '../src/page-summary.ts'

const header: SessionHeader = { formatVersion: 1, createdAt: 10, cwd: '/repo' }

const changed = (seq: number, cwd: string, root?: string): SessionEvent => ({
  seq,
  time: seq * 10,
  type: 'session/cwd/changed',
  data: root === undefined ? { cwd } : { cwd, root },
})

describe('the summary the web page reads', () => {
  test('names the directory the log moved to, including a move that arrives after it was built', () => {
    const events: Array<SessionEvent> = []
    const summary = pageSummary({ id: 's', header, events: () => events })

    expect(summary.cwd).toBe('/repo')
    expect(summary.updatedAt).toBe(10)
    expect(summary.title).toBe('')

    events.push(changed(2, '/repo/wt', '/repo/wt'))
    expect(summary.cwd).toBe('/repo/wt')
    expect(summary.updatedAt).toBe(20)

    // A later working_directory sits under the worktree. The page follows that
    // directory, not the root the worktree move named.
    events.push(changed(3, '/repo/wt/pkg'))
    expect(summary.cwd).toBe('/repo/wt/pkg')

    events.push({
      seq: 4,
      time: 40,
      type: 'user/message',
      data: { text: 'count the files', source: 'user' },
    })
    expect(summary.title).toBe('count the files')
    expect(summary.updatedAt).toBe(40)
  })
})
