import { describe, expect, test } from 'vitest'
import { linkPartsOf } from '../src/ui/linkify.ts'

describe('the link splitter', () => {
  test('finds a bare URL and keeps the prose around it', () => {
    expect(linkPartsOf('see https://example.com/a?x=1&y=2 now.')).toEqual([
      { kind: 'text', text: 'see ' },
      {
        kind: 'link',
        href: 'https://example.com/a?x=1&y=2',
        label: 'https://example.com/a?x=1&y=2',
      },
      { kind: 'text', text: ' now.' },
    ])
  })

  test('leaves sentence punctuation and an unmatched bracket outside the URL', () => {
    expect(linkPartsOf('(https://example.com/docs).')).toEqual([
      { kind: 'text', text: '(' },
      { kind: 'link', href: 'https://example.com/docs', label: 'https://example.com/docs' },
      { kind: 'text', text: ').' },
    ])
  })

  test('keeps a bracket that the URL opened itself', () => {
    expect(linkPartsOf('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      {
        kind: 'link',
        href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
        label: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      },
    ])
  })

  test('reads a markdown link as one link instead of a URL in its label', () => {
    expect(
      linkPartsOf('[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and https://e.x/a.'),
    ).toEqual([
      {
        kind: 'link',
        href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
        label: 'wiki',
      },
      { kind: 'text', text: ' and ' },
      { kind: 'link', href: 'https://e.x/a', label: 'https://e.x/a' },
      { kind: 'text', text: '.' },
    ])
  })

  test('only http and https links are made', () => {
    expect(linkPartsOf('[x](javascript:alert(1)) and [y](//evil.example/z)')).toEqual([
      { kind: 'text', text: '[x](javascript:alert(1)) and [y](//evil.example/z)' },
    ])
  })

  test('a URL cut by truncation is not linked', () => {
    expect(linkPartsOf('fetched https://example.com/very/long…')).toEqual([
      { kind: 'text', text: 'fetched https://example.com/very/long…' },
    ])
  })

  test('plain text comes back as one run', () => {
    expect(linkPartsOf('nothing to see')).toEqual([{ kind: 'text', text: 'nothing to see' }])
    expect(linkPartsOf('')).toEqual([])
  })
})
