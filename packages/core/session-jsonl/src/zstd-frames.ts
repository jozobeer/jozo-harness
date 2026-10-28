/**
 * Reading a concatenated zstd file. dsh and jozo-harness append one frame per
 * write, so a file is a chain of frames rather than one; decoding the first and
 * stopping would hide every later event. The lengths are in the headers, so the
 * frames can be split without decompressing them, and the last one may be short
 * because a crash cut it.
 */

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
/** Skippable frames (0x184D2A5x) carry a 4-byte size of their own; neither writer emits them. */
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_MAGIC = 0x184d2a50

/** Where the block headers start, after the magic, descriptor, and optional sizes. */
const blockStart = (descriptor: number, start: number): number => {
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryFlag = descriptor & 0x03
  const contentSizeFlag = descriptor >>> 6
  const window = singleSegment ? 0 : 1
  const dictionary = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSize = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  return start + 5 + window + dictionary + contentSize
}

/** Where one block ends; the block header says its size and whether it is the last. */
const blockEnd = (header: number, at: number): number => {
  const type = (header >>> 1) & 0x03
  const size = header >>> 3
  if (type === 3) throw new Error(`reserved zstd block type at byte ${at}`)
  return at + 3 + (type === 1 ? 1 : size)
}

/**
 * Where the frame that starts at `start` ends. The header and the 3-byte block
 * headers carry every length, so the frame can be walked without decoding it; a
 * length that runs past the buffer is what a crash leaves, and the caller decides
 * whether that is a torn tail.
 */
export const zstdFrameEnd = (data: DataView, start: number): number => {
  const magic = data.getUint32(start, true)
  if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
    const size = data.getUint32(start + 4, true)
    return start + 8 + size
  }
  if (magic !== ZSTD_MAGIC) {
    throw new Error(`not a zstd frame at byte ${start}: 0x${magic.toString(16)}`)
  }
  const descriptor = data.getUint8(start + 4)
  const checksum = (descriptor & 0x04) === 0 ? 0 : 4
  let at = blockStart(descriptor, start)
  for (;;) {
    const header = data.getUint8(at) | (data.getUint8(at + 1) << 8) | (data.getUint8(at + 2) << 16)
    at = blockEnd(header, at)
    if ((header & 1) !== 0) return at + checksum
  }
}

/** One line as one zstd frame, which is how both writers append. */
export const encodeZstdFrame = (text: string): Buffer => zstdCompressSync(Buffer.from(text))

export interface SplitZstdLog {
  /** The complete frames, in the order they were written. */
  readonly frames: ReadonlyArray<Uint8Array>
  /** The text of every complete frame. */
  readonly text: string
  /** The bytes after the last complete frame; a crash cut the next frame short. */
  readonly tornBytes: number
  /** Where the first frame ends, or 0 when its header was cut too short to read. */
  readonly firstFrameEnd: number
}

/** Where the frame at `at` ends, or undefined when the file ends inside its header. */
const frameEndAt = (data: DataView, at: number): number | undefined => {
  try {
    return zstdFrameEnd(data, at)
  } catch (cause) {
    // A header the end of the file cut short cannot be walked; a corrupt one is not a tail.
    if (cause instanceof RangeError) return undefined
    throw cause
  }
}

/** One whole frame, or an error saying which frame did not decode. */
const decodeFrame = (buffer: Uint8Array, at: number, end: number): Uint8Array => {
  try {
    return zstdDecompressSync(buffer.subarray(at, end))
  } catch (cause) {
    throw new Error(`the zstd frame at byte ${at} does not decode`, { cause })
  }
}

/** Splits a log at its frame boundaries, keeping the frames that were written whole. */
export const splitZstdLog = (buffer: Uint8Array): SplitZstdLog => {
  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const frames: Array<Uint8Array> = []
  const decoded: Array<Uint8Array> = []
  let firstFrameEnd = 0
  let at = 0
  while (at < buffer.byteLength) {
    const end = frameEndAt(data, at)
    if (end === undefined) break
    if (at === 0) firstFrameEnd = end
    if (end > buffer.byteLength) break
    frames.push(buffer.subarray(at, end))
    decoded.push(decodeFrame(buffer, at, end))
    at = end
  }
  return {
    frames,
    // Decoded once: a frame boundary may fall inside a multi-byte character.
    text: new TextDecoder().decode(Buffer.concat(decoded)),
    tornBytes: buffer.byteLength - at,
    firstFrameEnd,
  }
}

/** The text of every frame in a concatenated zstd file, in the order they were written. */
export const zstdText = (buffer: Uint8Array): string => {
  const split = splitZstdLog(buffer)
  if (split.tornBytes > 0) {
    throw new Error(`the zstd log ends inside a frame (${String(split.tornBytes)} bytes)`)
  }
  return split.text
}
