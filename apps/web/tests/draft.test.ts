import { describe, expect, test } from 'vitest'
import { draftKey, draftOnMove, drafted } from '../src/ui/draft.ts'

describe('the composer draft', () => {
  test('each session keeps its own line, and an emptied one leaves nothing behind', () => {
    const drafts = drafted(drafted(new Map(), 'a', 'half typed'), 'b', 'another')
    expect(drafts.get('a')).toBe('half typed')
    expect(drafts.get('b')).toBe('another')
    expect(drafted(drafts, 'a', '').has('a')).toBe(false)
    expect(drafted(drafts, 'b', 'changed').get('b')).toBe('changed')
  })

  test('a line typed before any session exists belongs to the first one opened', () => {
    const moved = draftOnMove(new Map([['', 'the first line']]), '', 'a', '')
    expect(moved.text).toBe('the first line')
    expect(moved.drafts.get('a')).toBe('the first line')
    expect(moved.drafts.has('')).toBe(false)
  })

  test('moving back to a session brings back what was left there', () => {
    const drafts = new Map([['a', 'half typed']])
    expect(draftOnMove(drafts, 'b', 'a', '').text).toBe('half typed')
    // Nothing typed this visit reads what the last one stored for the session.
    expect(draftOnMove(drafts, 'b', 'c', 'from the last visit').text).toBe('from the last visit')
  })

  test('a session that has its own draft keeps it, and the blank line waits for another', () => {
    const moved = draftOnMove(
      new Map([
        ['', 'the first line'],
        ['a', 'older'],
      ]),
      '',
      'a',
      '',
    )
    expect(moved.text).toBe('older')
    expect(moved.drafts.get('')).toBe('the first line')
  })

  test('a draft is stored under the session it belongs to', () => {
    expect(draftKey('a')).toBe('jzh:draft:a')
  })
})
