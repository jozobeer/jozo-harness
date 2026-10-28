import { describe, expect, test } from 'vitest'
import { SESSION_ORDER_KEY, keepOrder, movedIn, orderFrom, withMoved } from '../order.ts'

describe('the hand-picked row order', () => {
  test('moves one row by one place and stops at either end', () => {
    expect(movedIn(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(movedIn(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    const ids = ['a', 'b']
    // Nothing moves at an end, and the caller may keep the list it passed.
    expect(movedIn(ids, 'a', -1)).toBe(ids)
    expect(movedIn(ids, 'b', 1)).toBe(ids)
    expect(movedIn(ids, 'gone', 1)).toBe(ids)
  })

  test('a folder nobody ordered seeds its first move from the rows on screen', () => {
    const seeded = withMoved({}, '/work/a', ['one', 'two', 'three'], 'three', -1)
    expect(seeded).toEqual({ '/work/a': ['one', 'three', 'two'] })
    // Another workspace is left exactly as it was.
    const kept = withMoved({ '/work/b': ['x'] }, '/work/a', ['one', 'two'], 'one', 1)
    expect(kept).toEqual({ '/work/b': ['x'], '/work/a': ['two', 'one'] })
    // A row already at the end moves nowhere, so the stored order is left alone.
    expect(withMoved({ '/work/b': ['x'] }, '/work/a', ['one', 'two'], 'two', 1)).toEqual({
      '/work/b': ['x'],
    })
  })

  test('read back, an order keeps only workspaces that name their rows', () => {
    expect(orderFrom(null)).toEqual({})
    expect(orderFrom('not json')).toEqual({})
    expect(orderFrom('["a"]')).toEqual({})
    expect(
      orderFrom(JSON.stringify({ '/work/a': ['one', 2], '/work/b': [], '/work/c': 'no' })),
    ).toEqual({ '/work/a': ['one'] })
  })

  test('the kept order survives a reload under its own key', () => {
    keepOrder({ '/work/a': ['two', 'one'] })
    expect(orderFrom(localStorage.getItem(SESSION_ORDER_KEY))).toEqual({
      '/work/a': ['two', 'one'],
    })
  })
})
