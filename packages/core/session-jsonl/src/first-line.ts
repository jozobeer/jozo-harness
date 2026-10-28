import { Effect } from 'effect'
import { stat } from 'node:fs/promises'
import { persistenceError } from './errors.ts'
import { readHead } from './head.ts'
import { readZstdHead } from './zstd-log.ts'
import type { SessionError } from '@jozo-harness/session'

/** How much of a log is read to find its first line. */
export const HEADER_READ_BYTES = 64 * 1024

/**
 * The first line of a head, read without carrying the rest: a listing needs the
 * header, not the ten thousand events behind it. A first line longer than the
 * budget is refused rather than silently cut.
 */
const firstLineOf = (
  path: string,
  text: string,
  size: number,
  maxBytes: number,
): Effect.Effect<string, SessionError> => {
  const newline = text.indexOf('\n')
  if (newline >= 0) return Effect.succeed(text.slice(0, newline))
  if (size > maxBytes) {
    return Effect.fail(
      persistenceError(`the first line of ${path} is longer than ${String(maxBytes)} bytes`),
    )
  }
  return Effect.succeed(text)
}

/** The first line of a plaintext log, read without carrying the rest. */
export const readFirstLine = (
  path: string,
  maxBytes: number = HEADER_READ_BYTES,
): Effect.Effect<string, SessionError> =>
  Effect.gen(function* () {
    const info = yield* Effect.tryPromise({
      try: () => stat(path),
      catch: (cause) => persistenceError(`cannot look at ${path}`, cause),
    })
    const text = yield* Effect.tryPromise({
      try: () => readHead(path, maxBytes),
      catch: (cause) => persistenceError(`cannot read ${path}`, cause),
    })
    return yield* firstLineOf(path, text, info.size, maxBytes)
  })

/** What a zstd log's header read gave back, and where its first frame ends. */
export interface ZstdFirstLine {
  readonly line: string
  readonly firstFrameEnd: number
}

/** The first line of a zstd log, decoded from the frames that fit in the head. */
export const readZstdFirstLine = (
  path: string,
  maxBytes: number = HEADER_READ_BYTES,
): Effect.Effect<ZstdFirstLine, SessionError> =>
  Effect.gen(function* () {
    const info = yield* Effect.tryPromise({
      try: () => stat(path),
      catch: (cause) => persistenceError(`cannot look at ${path}`, cause),
    })
    const head = yield* Effect.tryPromise({
      try: () => readZstdHead(path, maxBytes),
      catch: (cause) => persistenceError(`cannot read ${path}`, cause),
    })
    const line = yield* firstLineOf(path, head.text, info.size, maxBytes)
    return { line, firstFrameEnd: head.firstFrameEnd }
  })
