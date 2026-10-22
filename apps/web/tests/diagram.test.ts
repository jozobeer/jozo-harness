import { describe, expect, test } from 'vitest'
import { IMAGE_DATA_MAX_BYTES, imageViewOf } from '../src/ui/diagram.ts'

describe('the image source', () => {
  test('draws an http or https URL', () => {
    expect(imageViewOf('https://e.x/a.png')).toEqual({ kind: 'draw', src: 'https://e.x/a.png' })
    expect(imageViewOf('http://e.x/a.png')).toEqual({ kind: 'draw', src: 'http://e.x/a.png' })
  })

  test('draws a raster data URL under the limit', () => {
    for (const mime of ['png', 'jpeg', 'gif', 'webp']) {
      const url = 'data:image/' + mime + ';base64,AAAA'
      expect(imageViewOf(url)).toEqual({ kind: 'draw', src: url })
    }
  })

  test('a data URL past the limit becomes a link', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(IMAGE_DATA_MAX_BYTES)
    expect(imageViewOf(url)).toEqual({ kind: 'link', href: url })
  })

  test('an svg data URL and another scheme stay text', () => {
    expect(imageViewOf('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined()
    expect(imageViewOf('javascript:alert(1)')).toBeUndefined()
    expect(imageViewOf('//evil.example/a.png')).toBeUndefined()
  })
})
