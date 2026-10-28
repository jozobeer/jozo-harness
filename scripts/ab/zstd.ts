/**
 * Reading a dsh session log. dsh appends a frame per write, so the file is a chain
 * of frames rather than one. The frame reader lives beside the session store that
 * writes the same shape, so the A/B and the store agree on what a frame is.
 */

export { zstdText } from '../../packages/core/session-jsonl/src/zstd-frames.ts'
