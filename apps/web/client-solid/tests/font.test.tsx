import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test } from 'vitest'
import { FONT_FAMILY_KEY, FONT_SIZE_KEY } from '../../src/ui/font.ts'
import {
  keepFontFamily,
  keepFontSize,
  keptFontFamily,
  keptFontSize,
  showFontFamily,
  showFontSize,
} from '../dom.ts'

const sheet = (path: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), path), 'utf8')

describe('the face and size a page keeps', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
  })

  test('a chosen face is written where the stylesheet reads it and kept for the next visit', () => {
    showFontFamily('serif')
    keepFontFamily('serif')

    expect(document.documentElement.style.getPropertyValue('--font-family')).toBe('var(--serif)')
    expect(localStorage.getItem(FONT_FAMILY_KEY)).toBe('serif')
    expect(keptFontFamily()).toBe('serif')
  })

  test('a chosen size scales the type scale and survives a reload', () => {
    showFontSize(18)
    keepFontSize(18)

    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe(String(18 / 14))
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe('18')
    expect(keptFontSize()).toBe(18)
  })

  test('a first visit keeps the face and size the sheet was drawn for', () => {
    expect(keptFontFamily()).toBe('sans')
    expect(keptFontSize()).toBe(14)
  })

  test('every step of the scale follows the size, and the body follows the face', () => {
    const stylesheet = sheet('../../src/ui/style.css')

    for (const step of ['--text-xs', '--text-sm', '--text-base', '--text-md', '--text-lg']) {
      expect(stylesheet).toContain(step + ': calc(')
    }
    expect(stylesheet).toContain('var(--font-scale)')
    expect(stylesheet).toContain('font: var(--text-base) / 1.6 var(--font-family);')
    // No rule pins a face of its own, so the choice reaches every label too.
    expect(
      stylesheet
        .split('\n')
        .filter((line) => line.includes('font-family: var(--sans)'))
        .map((line) => line.trim()),
    ).toEqual(['--font-family: var(--sans);'])
  })
})
