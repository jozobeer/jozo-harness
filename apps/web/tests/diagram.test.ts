import { describe, expect, test } from 'vitest'
import { imageSrcOf } from '../src/ui/diagram.ts'

describe('the image source', () => {
  test('takes http and https images, and nothing else', () => {
    expect(imageSrcOf('https://e.x/a.png')).toBe('https://e.x/a.png')
    expect(imageSrcOf('http://e.x/a.png')).toBe('http://e.x/a.png')
    expect(imageSrcOf('javascript:alert(1)')).toBeUndefined()
    expect(imageSrcOf('data:image/png;base64,AAAA')).toBeUndefined()
    expect(imageSrcOf('//evil.example/a.png')).toBeUndefined()
  })
})
