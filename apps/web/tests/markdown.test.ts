import { describe, expect, test } from 'vitest'
import { renderMarkdown } from '../src/ui/markdown.ts'

describe('the markdown renderer', () => {
  test('text that looks like markup stays text', () => {
    const view = renderMarkdown('<script>alert(1)</scr' + 'ipt>')
    expect(view).not.toContain('<script')
    expect(view).toContain('&lt;script&gt;')
  })

  test('a fenced block keeps its body and names its language', () => {
    const view = renderMarkdown('before\n\n```ts\nconst a = 1 < 2\n```\n\nafter')
    expect(view).toBe(
      '<p>before</p>' +
        '<pre class="code" data-lang="ts"><code>const a = 1 &lt; 2</code></pre>' +
        '<p>after</p>',
    )
  })

  test('a fence that never closes still renders as code', () => {
    const view = renderMarkdown('```\nno end')
    expect(view).toBe('<pre class="code"><code>no end</code></pre>')
  })

  test('headings, lists, quotes and rules take their block shape', () => {
    const view = renderMarkdown('# Title\n\n- one\n- two\n\n1. first\n\n> note\n\n---')
    expect(view).toBe(
      '<h1>Title</h1>' +
        '<ul><li>one</li><li>two</li></ul>' +
        '<ol><li>first</li></ol>' +
        '<blockquote>note</blockquote>' +
        '<hr>',
    )
  })

  test('inline code, emphasis and links are marked up once', () => {
    const view = renderMarkdown('use `pnpm **now**` and **bold** plus [docs](https://e.x/a)')
    expect(view).toBe(
      '<p>use <code>pnpm **now**</code> and <strong>bold</strong> plus ' +
        '<a href="https://e.x/a" target="_blank" rel="noreferrer noopener">docs</a></p>',
    )
  })

  test('a link the browser may not follow stays text', () => {
    const view = renderMarkdown('[x](javascript:alert(1))')
    expect(view).not.toContain('<a ')
    expect(view).toContain('[x](javascript:alert(1))')
  })

  test('a single newline inside a paragraph is a line break', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one<br>two</p>')
  })

  test('a bare URL becomes a link with its query escaped once', () => {
    const view = renderMarkdown('see https://example.com/a?x=1&y=2 now')
    expect(view).toBe(
      '<p>see <a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noreferrer noopener">' +
        'https://example.com/a?x=1&amp;y=2</a> now</p>',
    )
  })

  test('sentence punctuation stays outside a bare URL', () => {
    const view = renderMarkdown('see (https://example.com/docs).')
    expect(view).toBe(
      '<p>see (<a href="https://example.com/docs" target="_blank" rel="noreferrer noopener">' +
        'https://example.com/docs</a>).</p>',
    )
  })

  test('a URL keeps a bracket pair it opened itself', () => {
    const view = renderMarkdown('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(view).toBe(
      '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noreferrer noopener">' +
        'https://en.wikipedia.org/wiki/Foo_(bar)</a></p>',
    )
  })

  test('a URL inside code stays code', () => {
    expect(renderMarkdown('`https://example.com`')).toBe('<p><code>https://example.com</code></p>')
    expect(renderMarkdown('```\nhttps://example.com\n```')).toBe(
      '<pre class="code"><code>https://example.com</code></pre>',
    )
  })

  test('a link whose href has a bracket pair keeps the whole href', () => {
    const view = renderMarkdown('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')
    expect(view).toBe(
      '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noreferrer noopener">' +
        'wiki</a></p>',
    )
  })

  test('a protocol-relative link stays text', () => {
    const view = renderMarkdown('[x](//evil.example/x)')
    expect(view).not.toContain('<a ')
    expect(view).toContain('[x](//evil.example/x)')
  })

  test('a quote in a link href cannot leave its attribute', () => {
    const view = renderMarkdown('[x](https://e.x/a"onmouseover="alert(1))')
    expect(view).not.toContain('"onmouseover="')
    expect(view).toContain('&quot;onmouseover=&quot;')
  })

  test('markup after a bare URL stays escaped text', () => {
    const view = renderMarkdown('see https://e.x/"><img src=x onerror=alert(1)>')
    expect(view).not.toContain('<img')
    expect(view).toContain('&lt;img')
  })

  test('a pipe table draws three columns with their alignments and inline markup', () => {
    const view = renderMarkdown(
      '| name | count | note |\n| :--- | ---: | :---: |\n| `a` | 3 | **bold** |\n| b | 4 | plain |',
    )
    expect(view).toBe(
      '<table><thead><tr>' +
        '<th class="align-left">name</th>' +
        '<th class="align-right">count</th>' +
        '<th class="align-center">note</th>' +
        '</tr></thead><tbody>' +
        '<tr>' +
        '<td class="align-left"><code>a</code></td>' +
        '<td class="align-right">3</td>' +
        '<td class="align-center"><strong>bold</strong></td>' +
        '</tr>' +
        '<tr>' +
        '<td class="align-left">b</td>' +
        '<td class="align-right">4</td>' +
        '<td class="align-center">plain</td>' +
        '</tr>' +
        '</tbody></table>',
    )
  })

  test('pipe prose without a delimiter row stays a paragraph', () => {
    expect(renderMarkdown('a | b\njust text')).toBe('<p>a | b<br>just text</p>')
  })

  test('a pipe inside a code span does not split its cell', () => {
    const view = renderMarkdown('| cmd |\n| --- |\n| `a | b` |')
    expect(view).toBe(
      '<table><thead><tr><th>cmd</th></tr></thead><tbody>' +
        '<tr><td><code>a | b</code></td></tr></tbody></table>',
    )
  })
})
