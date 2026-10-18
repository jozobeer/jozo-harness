/**
 * Reading a dsh session log. It is zstd, and dsh appends a frame per write, so the
 * file is a chain of frames rather than one. \`node:zlib\` decodes the first frame and
 * stops without an error, which counted every dsh run as zero tools, so the frames
 * are split here and decoded one by one.
 */

import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
/** Skippable frames (0x184D2A5x) carry a 4-byte size of their own; dsh does not write them. */
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_MAGIC = 0x184d2a50

/**
 * Where the frame that starts at \`start\` ends. The header and the 3-byte block headers
 * carry every length, so the frame can be walked without decoding it; a length that
 * runs past the file is an error rather than a shorter read.
 */
const frameEnd = (data: DataView, start: number): number => {
  const magic = data.getUint32(start, true)
  if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
    const size = data.getUint32(start + 4, true)
    return start + 8 + size
  }
  if (magic !== ZSTD_MAGIC) {
    throw new Error(`not a zstd frame at byte ${start}: 0x${magic.toString(16)}`)
  }
  const descriptor = data.getUint8(start + 4)
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryFlag = descriptor & 0x03
  let at = start + 5
  if (!singleSegment) at += 1
  at += dictionaryFlag === 3 ? 4 : dictionaryFlag
  at += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag

  for (;;) {
    const header = data.getUint8(at) | (data.getUint8(at + 1) << 8) | (data.getUint8(at + 2) << 16)
    const last = (header & 1) !== 0
    const type = (header >>> 1) & 0x03
    const size = header >>> 3
    if (type === 3) throw new Error(`reserved zstd block type at byte ${at}`)
    at += 3 + (type === 0 || type === 2 ? size : 1)
    if (last) break
  }
  return (descriptor & 0x04) === 0 ? at : at + 4
}

/** The text of every frame in a concatenated zstd file, in the order they were written. */
export const zstdText = (buffer: Uint8Array): string => {
  if (buffer.byteLength === 0) return ''
  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const frames: Array<Uint8Array> = []
  for (let at = 0; at < buffer.byteLength;) {
    const end = frameEnd(data, at)
    if (end > buffer.byteLength) {
      throw new Error(`the zstd frame at byte ${at} ends at ${end}, past the file`)
    }
    frames.push(zstdDecompressSync(buffer.subarray(at, end)))
    at = end
  }
  // Decoded once: a frame boundary may fall inside a multi-byte character.
  return new TextDecoder().decode(Buffer.concat(frames))
}
