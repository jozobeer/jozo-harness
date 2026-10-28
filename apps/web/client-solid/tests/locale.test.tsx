import { describe, expect, it } from 'vitest'
import { formatCompact, formatDate, localeFrom, message } from '../locale.ts'

describe('the language a page opens in', () => {
  it('opens in the language the reader chose, whatever the browser asks for', () => {
    expect(localeFrom('ja', ['en-US'])).toBe('ja')
  })

  it('opens in the browser language when the reader has chosen none', () => {
    expect(localeFrom(null, ['ja-JP', 'en-US'])).toBe('ja')
  })

  it('opens in the default language when no one names one the page speaks', () => {
    expect(localeFrom(null, ['fr-FR'])).toBe('en')
  })

  it('ignores a stored language the page no longer speaks and asks the browser', () => {
    expect(localeFrom('fr', ['ja-JP'])).toBe('ja')
  })
})

describe('the fixed lines of the page', () => {
  it('writes a line in the language asked for', () => {
    expect(message('ja', 'rail.hide')).toBe('セッションを隠す')
  })

  it('keeps the default line when a language leaves it out', () => {
    expect(message('ja', 'app.name')).toBe('jozo-harness')
  })
})

describe('the formats a language reads dates and counts in', () => {
  const day = new Date(2026, 9, 29, 15, 4)

  it('writes a day in the language order', () => {
    expect(formatDate('en', day)).toBe('Oct 29, 2026')
    expect(formatDate('ja', day)).toBe('2026年10月29日')
  })

  it('writes a large count the short way the language does', () => {
    expect(formatCompact('en', 1_000_000)).toBe('1M')
    expect(formatCompact('ja', 1_000_000)).toBe('100万')
  })
})
