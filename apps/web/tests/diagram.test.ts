import { describe, expect, test } from 'vitest'
import { SVG_MAX_BYTES, imageSrcOf, svgDataUrl } from '../src/ui/diagram.ts'

describe('the diagram source', () => {
  test('encodes an SVG fence as a data URL', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4"/></svg>')
    expect(url).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(atob((url ?? '').split(',')[1] ?? '')).toContain('<rect width="4"/>')
  })

  test('draws nothing for an empty fence', () => {
    expect(svgDataUrl('  \n ')).toBeUndefined()
  })

  test('keeps an SVG past the size limit as code', () => {
    const big = '<svg>' + 'x'.repeat(SVG_MAX_BYTES) + '</svg>'
    expect(svgDataUrl(big)).toBeUndefined()
  })

  test('takes http and https images, and nothing else', () => {
    expect(imageSrcOf('https://e.x/a.png')).toBe('https://e.x/a.png')
    expect(imageSrcOf('http://e.x/a.png')).toBe('http://e.x/a.png')
    expect(imageSrcOf('javascript:alert(1)')).toBeUndefined()
    expect(imageSrcOf('data:image/png;base64,AAAA')).toBeUndefined()
    expect(imageSrcOf('//evil.example/a.png')).toBeUndefined()
  })
})
