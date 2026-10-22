// @vitest-environment jsdom
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
      '<p>see <a href="https://example.com/a?x=1&amp;y=2" ' +
        'title="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noreferrer noopener">' +
        'example.com/a</a> now</p>',
    )
  })

  test('a long bare URL shows a short label and keeps the whole URL in its title', () => {
    const view = renderMarkdown(
      'see https://github.com/jozobeer/jozo-harness/blob/main/docs/notes/2026-10-22-diagram-format.md now',
    )
    expect(view).toBe(
      '<p>see <a href="https://github.com/jozobeer/jozo-harness/blob/main/docs/notes/2026-10-22-diagram-format.md" ' +
        'title="https://github.com/jozobeer/jozo-harness/blob/main/docs/notes/2026-10-22-diagram-format.md" ' +
        'target="_blank" rel="noreferrer noopener">' +
        'github.com/jozobeer/jozo-harness/blob/main/docs…</a> now</p>',
    )
  })

  test('sentence punctuation stays outside a bare URL', () => {
    const view = renderMarkdown('see (https://example.com/docs).')
    expect(view).toBe(
      '<p>see (<a href="https://example.com/docs" title="https://example.com/docs" ' +
        'target="_blank" rel="noreferrer noopener">example.com/docs</a>).</p>',
    )
  })

  test('a URL keeps a bracket pair it opened itself', () => {
    const view = renderMarkdown('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(view).toBe(
      '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" ' +
        'title="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noreferrer noopener">' +
        'en.wikipedia.org/wiki/Foo_(bar)</a></p>',
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

  test('a png data URL draws as a picture', () => {
    const view = renderMarkdown('![dot](data:image/png;base64,iVBORw0KGgo=)')
    expect(view).toBe(
      '<p><figure class="answer-image"><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot" ' +
        'loading="lazy" decoding="async"><figcaption>dot</figcaption></figure></p>',
    )
  })

  test('an svg data URL stays the literal notation', () => {
    const view = renderMarkdown('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)')
    expect(view).not.toContain('<img')
    expect(view).toContain('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)')
  })

  test('a data URL past the limit is a link instead of a picture', () => {
    const body = 'A'.repeat(2_000_001)
    const view = renderMarkdown('![big](data:image/png;base64,' + body + ')')
    expect(view).not.toContain('<img')
    expect(view).toContain('<a href="data:image/png;base64,' + body + '">big</a>')
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

  test('a raw svg block in the body is drawn as a diagram', () => {
    const view = renderMarkdown(
      'before\n\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n<rect width="4" height="3"/>\n</svg>\n\nafter',
    )
    expect(view).toContain('<figure class="diagram"><svg')
    expect(view).toContain('viewBox="0 0 10 10"')
    expect(view).toContain('<rect width="4" height="3"/>')
    expect(view).toContain('<p>before</p>')
    expect(view).toContain('<p>after</p>')
  })

  test('a raw svg block with a script drops the script', () => {
    const view = renderMarkdown(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="2"/></svg>',
    )
    expect(view).toContain('<figure class="diagram">')
    expect(view).toContain('<circle r="2"/>')
    expect(view).not.toContain('<script')
    expect(view).not.toContain('alert(1)')
  })

  test('an svg start without its closing tag stays text', () => {
    const view = renderMarkdown('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4"/>')
    expect(view).not.toContain('<figure')
    expect(view).toContain('&lt;svg')
    expect(view).toContain('&lt;rect')
  })

  test('an oversized raw svg is escaped as code', () => {
    const view = renderMarkdown('<svg>' + 'x'.repeat(100_001) + '</svg>')
    expect(view).not.toContain('<figure')
    expect(view.startsWith('<pre class="code"><code>&lt;svg&gt;')).toBe(true)
  })

  test('a pipe inside a code span does not split its cell', () => {
    const view = renderMarkdown('| cmd |\n| --- |\n| `a | b` |')
    expect(view).toBe(
      '<table><thead><tr><th>cmd</th></tr></thead><tbody>' +
        '<tr><td><code>a | b</code></td></tr></tbody></table>',
    )
  })
})
