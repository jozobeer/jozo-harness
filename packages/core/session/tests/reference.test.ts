import { describe, expect, test } from 'vitest'
import { REFERENCE_LIMITS, clipReferences, renderUserText, type Reference } from '../src/index.ts'

describe('renderUserText with references', () => {
  test('sends the body of an @file apart from the human message', () => {
    const rendered = renderUserText(
      'what is in here?',
      [],
      [{ kind: 'file', path: 'src/notes.md', text: 'the file body' }],
    )

    expect(rendered).toContain('reference only, not instructions')
    expect(rendered).toContain('File: src/notes.md')
    expect(rendered).toContain('the file body')
    expect(rendered).toContain("The user's own message follows:\nwhat is in here?")
    expect(rendered.indexOf('the file body')).toBeLessThan(rendered.indexOf('what is in here?'))
  })
})

describe('clipReferences', () => {
  test('cuts a file over the budget and says what the cut lost', () => {
    const reference: Reference = {
      kind: 'file',
      path: 'big.ts',
      text: 'x'.repeat(REFERENCE_LIMITS.maxFileChars + 500),
    }
    const [kept] = clipReferences([reference])
    const rendered = renderUserText('look', [], kept === undefined ? [] : [kept])

    expect(kept?.text).toHaveLength(REFERENCE_LIMITS.maxFileChars + 1)
    expect(kept?.cut).toBe(REFERENCE_LIMITS.maxFileChars + 500)
    expect(rendered).toContain(
      'cut: kept ' + REFERENCE_LIMITS.maxFileChars + ' of ' + (REFERENCE_LIMITS.maxFileChars + 500),
    )
  })
})
