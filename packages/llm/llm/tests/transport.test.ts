import { describe, expect, test } from 'vitest'
import { transportFailureText } from '../src/index.ts'

const refused = (address: string): Error =>
  Object.assign(new Error('connect ECONNREFUSED ' + address), { code: 'ECONNREFUSED' })

describe('transportFailureText', () => {
  test('names the socket error fetch hides under its cause', () => {
    const failure = new TypeError('fetch failed', { cause: refused('127.0.0.1:11434') })

    expect(transportFailureText(failure)).toBe(
      'TypeError: fetch failed (connect ECONNREFUSED 127.0.0.1:11434)',
    )
  })

  test('walks every level of the cause chain in order', () => {
    const inner = new Error('getaddrinfo ENOTFOUND example.test')
    const middle = new Error('socket hang up', { cause: inner })
    const failure = new TypeError('fetch failed', { cause: middle })

    expect(transportFailureText(failure)).toBe(
      'TypeError: fetch failed (socket hang up; getaddrinfo ENOTFOUND example.test)',
    )
  })

  test('leaves an error without a cause as it reads', () => {
    expect(transportFailureText(new Error('offline'))).toBe('Error: offline')
  })

  test('reads a cause that is not an Error as text', () => {
    const failure = new TypeError('fetch failed', { cause: 'reset by peer' })

    expect(transportFailureText(failure)).toBe('TypeError: fetch failed (reset by peer)')
  })

  test('stops on a cause chain that loops back on itself', () => {
    const looping = new Error('again')
    Object.assign(looping, { cause: looping })

    expect(transportFailureText(new TypeError('fetch failed', { cause: looping }))).toBe(
      'TypeError: fetch failed (again)',
    )
  })
})
