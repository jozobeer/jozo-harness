import { describe, expect, test } from 'vitest'
import { completedReference, referenceTokenAt, referencesFor } from '../src/ui/references.ts'

describe('the reference word under the caret', () => {
  test('an @ after a space or at the start of the text opens the word', () => {
    expect(referenceTokenAt('@comp', 5)).toEqual({
      text: '@comp',
      start: 0,
      end: 5,
      query: 'comp',
    })
    expect(referenceTokenAt('look at @comp', 13)).toEqual({
      text: '@comp',
      start: 8,
      end: 13,
      query: 'comp',
    })
    expect(referenceTokenAt('one\n@comp', 9)).toEqual({
      text: '@comp',
      start: 4,
      end: 9,
      query: 'comp',
    })
  })

  test('the query is what sits between the @ and the caret', () => {
    expect(referenceTokenAt('@apps/web', 5)).toMatchObject({ query: 'apps', end: 9 })
  })

  test('an @ inside a word is not a reference', () => {
    expect(referenceTokenAt('mail a@comp', 11)).toBeUndefined()
    expect(referenceTokenAt('@@comp', 6)).toBeUndefined()
  })

  test('a caret after a space has left the word', () => {
    expect(referenceTokenAt('@comp done', 6)).toBeUndefined()
  })

  test('the last reference wins when a line holds more than one', () => {
    expect(referenceTokenAt('hi @one @two', 12)).toMatchObject({
      start: 8,
      end: 12,
      query: 'two',
    })
  })
})

describe('accepting one reference', () => {
  test('the word is replaced with @path and a space for whatever follows', () => {
    expect(
      completedReference(
        'see @comp',
        { text: '@comp', start: 4, end: 9, query: 'comp' },
        'apps/web/composer.tsx',
      ),
    ).toEqual({ text: 'see @apps/web/composer.tsx ', caret: 27 })
  })

  test('text after the caret stays after the inserted path', () => {
    const token = referenceTokenAt('see @comp now', 9)
    expect(token).toBeDefined()
    expect(completedReference('see @comp now', token!, 'apps/web/composer.tsx')).toEqual({
      text: 'see @apps/web/composer.tsx  now',
      caret: 27,
    })
  })
})

describe('the matches a page may show', () => {
  const token = { text: '@comp', start: 0, end: 5, query: 'comp' }
  const matches = { sessionId: 'a', query: 'comp', paths: ['apps/web/composer.tsx'] }

  test('matches belong to the session and the word that asked for them', () => {
    expect(referencesFor(matches, 'a', token)).toEqual(['apps/web/composer.tsx'])
    expect(referencesFor(matches, 'b', token)).toEqual([])
    expect(referencesFor({ ...matches, query: 'co' }, 'a', token)).toEqual([])
    expect(referencesFor(undefined, 'a', token)).toEqual([])
  })
})
