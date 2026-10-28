import { readFile } from 'node:fs/promises'
import { readHeadBytes } from './head.ts'
import { splitZstdLog } from './zstd-frames.ts'

export interface ZstdHead {
  /** The text of the frames that fit in the head, whole. */
  readonly text: string
  /** Where the first frame ends, or 0 when its header was cut too short to read. */
  readonly firstFrameEnd: number
}

/**
 * The head of a zstd log, decoded frame by frame. A frame the read budget cut in
 * two is left out rather than half-decoded, so the caller only sees complete lines.
 */
export const readZstdHead = async (path: string, maxBytes: number): Promise<ZstdHead> => {
  const split = splitZstdLog(await readHeadBytes(path, maxBytes))
  return { text: split.text, firstFrameEnd: split.firstFrameEnd }
}

/** The whole text of a zstd log; bytes a crash cut from its tail are left out. */
export const readZstdText = async (path: string): Promise<string> =>
  splitZstdLog(await readFile(path)).text
