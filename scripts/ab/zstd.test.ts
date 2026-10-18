import { zstdCompressSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { zstdText } from './zstd.ts'

/** One frame, as dsh writes it: a session log appends a frame per write. */
const frameOf = (text: string): Buffer => zstdCompressSync(Buffer.from(text))

describe('a dsh session log', () => {
  test('reads every frame, not only the first', () => {
    const log = Buffer.concat([frameOf('{"type":"one"}\n'), frameOf('{"type":"two"}\n')])

    expect(zstdText(log)).toBe('{"type":"one"}\n{"type":"two"}\n')
  })

  test('reads a log that is one frame', () => {
    expect(zstdText(frameOf('{"type":"one"}\n'))).toBe('{"type":"one"}\n')
  })

  test('frames of every size, including incompressible ones, are read in order', () => {
    // A seeded generator: the frames are not in the source, so a decoder cannot know them.
    let seed = 20261018
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648)
    const frames = [0, 1, 7, 4096, 300].map((size) =>
      frameOf(String.fromCharCode(...Array.from({ length: size }, () => 33 + (next() % 94)))),
    )

    const read = zstdText(Buffer.concat(frames))

    expect(frames.map((frame) => zstdText(frame)).join('')).toBe(read)
    expect(read.length).toBe(0 + 1 + 7 + 4096 + 300)
  })

  test('reads a log that is not written yet as empty', () => {
    expect(zstdText(Buffer.alloc(0))).toBe('')
  })

  test('a frame cut short is an error, not a shorter log', () => {
    const whole = frameOf('{"type":"one"}\n'.repeat(40))

    expect(() => zstdText(whole.subarray(0, whole.byteLength - 1))).toThrow()
  })
})
