import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, test } from 'vitest'
import { Markdown } from '../components/turns.tsx'

afterEach(cleanup)

const viewOf = (text: string): HTMLElement => render(() => <Markdown text={text} />).container

const FENCE = '```'

describe('a chat answer with diagrams and images', () => {
  test('an svg fence draws one image, never live svg markup', () => {
    const view = viewOf(
      FENCE +
        'svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect /></svg>\n' +
        FENCE,
    )
    const images = view.querySelectorAll('img')
    expect(images).toHaveLength(1)
    expect(images[0]?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(view.querySelector('svg')).toBeNull()
    expect(view.querySelector('script')).toBeNull()
  })

  test('an https image draws with its alt as the caption', () => {
    const view = viewOf('a ![a cat](https://e.x/cat.png) here')
    const image = view.querySelector('figure.answer-image img')
    expect(image?.getAttribute('src')).toBe('https://e.x/cat.png')
    expect(image?.getAttribute('alt')).toBe('a cat')
    expect(view.querySelector('figcaption')?.textContent).toBe('a cat')
  })

  test('an image URL the browser may not load stays text', () => {
    const view = viewOf('![x](javascript:alert(1))')
    expect(view.querySelector('img')).toBeNull()
    expect(view.textContent).toContain('![x](javascript:alert(1))')
  })

  test('an empty svg fence stays a code block', () => {
    const view = viewOf(FENCE + 'svg\n\n' + FENCE)
    expect(view.querySelector('img')).toBeNull()
    expect(view.querySelector('pre.code')).not.toBeNull()
  })
})
