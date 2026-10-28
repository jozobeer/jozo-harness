import { describe, expect, test } from 'vitest'
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  FONT_FAMILIES,
  FONT_SIZES,
  familyStack,
  fontFamilyFrom,
  fontSizeFrom,
  fontSizeScale,
} from '../src/ui/font.ts'

describe('the face and size a page reads', () => {
  test('a choice the reader made is kept', () => {
    expect(fontFamilyFrom('serif')).toBe('serif')
    expect(fontFamilyFrom('mono')).toBe('mono')
    expect(fontSizeFrom('18')).toBe(18)
    expect(fontSizeFrom('12')).toBe(12)
  })

  test('a first visit and a key nobody wrote both read as the sheet was drawn', () => {
    expect(fontFamilyFrom(null)).toBe(DEFAULT_FONT_FAMILY)
    expect(fontFamilyFrom('comic')).toBe(DEFAULT_FONT_FAMILY)
    expect(fontFamilyFrom('14')).toBe(DEFAULT_FONT_FAMILY)
    expect(fontSizeFrom(null)).toBe(DEFAULT_FONT_SIZE)
    expect(fontSizeFrom('17')).toBe(DEFAULT_FONT_SIZE)
    expect(fontSizeFrom('serif')).toBe(DEFAULT_FONT_SIZE)
  })

  test('the choices stay a closed list', () => {
    expect(FONT_FAMILIES).toEqual(['sans', 'serif', 'mono'])
    expect(FONT_SIZES).toEqual([12, 13, 14, 15, 16, 18])
  })

  test('a family names the stack the stylesheet declares, never a copy of it', () => {
    expect(familyStack('sans')).toBe('var(--sans)')
    expect(familyStack('serif')).toBe('var(--serif)')
    expect(familyStack('mono')).toBe('var(--mono)')
  })

  test('the scale is one, so the sheet reads as before, at the size it was drawn for', () => {
    expect(fontSizeScale(DEFAULT_FONT_SIZE)).toBe('1')
    expect(fontSizeScale(18)).toBe(String(18 / 14))
    expect(fontSizeScale(12)).toBe(String(12 / 14))
  })
})
