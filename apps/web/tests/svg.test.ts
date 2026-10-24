// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { SVG_MAX_BYTES, svgMarkupOf, svgOf } from '../src/ui/svg.ts'

const diagram = (body: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' + body + '</svg>'

describe('the svg sanitizer', () => {
  test('draws an allowed diagram and keeps its viewBox', () => {
    const node = svgOf(diagram('<rect width="4" height="3" fill="red"/><text x="1">a</text>'))
    expect(node?.getAttribute('viewBox')).toBe('0 0 10 10')
    expect(node?.querySelector('rect')?.getAttribute('fill')).toBe('red')
    expect(node?.querySelector('text')?.textContent).toBe('a')
  })

  test('drops scripts, event handlers, foreignObject, links, and styles', () => {
    const markup = svgMarkupOf(
      diagram(
        '<script>alert(1)</script>' +
          '<rect onload="alert(1)" onclick="alert(2)" width="4"/>' +
          '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>' +
          '<a href="javascript:alert(1)"><circle r="2"/></a>' +
          '<use href="#x"/>' +
          '<style>*{fill:red}</style>' +
          '<animate attributeName="x"/>' +
          '<image href="https://e.x/a.png"/>',
      ),
    )
    expect(markup).toContain('<rect width="4"')
    for (const gone of [
      'script',
      'onload',
      'onclick',
      'foreignObject',
      'href',
      'style',
      'animate',
      'image',
      '<a',
    ])
      expect(markup).not.toContain(gone)
  })

  test('drops an external url in a presentation attribute and keeps a local one', () => {
    const markup = svgMarkupOf(
      diagram(
        '<linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>' +
          '<rect fill="url(#g)" stroke="url(https://evil.example/a)" width="4" height="3"/>' +
          '<line marker-start="url(//evil.example/m)" x1="0" y1="0" x2="1" y2="1"/>',
      ),
    )
    expect(markup).toContain('fill="url(#g)"')
    expect(markup).toContain('<line')
    expect(markup).not.toContain('evil.example')
    expect(markup).not.toContain('marker-start')
    expect(markup).not.toContain('stroke=')
  })

  test('drops an external url hidden by a css comment or a hex escape', () => {
    const markup = svgMarkupOf(
      diagram(
        '<rect fill="url(/*x*/https://evil.example/a)" width="1" height="1"/>' +
          '<rect fill="url(\\2f\\2fevil.example/b)" width="1" height="1"/>',
      ),
    )
    expect(markup).not.toContain('evil.example')
    expect(markup).not.toContain('url(')
  })

  test('keeps an oversized diagram as code', () => {
    const big = '<svg>' + 'x'.repeat(SVG_MAX_BYTES) + '</svg>'
    expect(svgOf(big)).toBeUndefined()
    expect(svgMarkupOf(big)).toBeUndefined()
  })

  test('draws nothing for an empty fence', () => {
    expect(svgOf('  \n ')).toBeUndefined()
  })
})
