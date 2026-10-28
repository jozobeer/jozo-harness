import {
  betterTitle,
  FIRST_MESSAGE_TITLE_RANK,
  type SessionError,
  type TitleCandidate,
  TITLE_RANK,
  titleEventOfRecord,
  titleOfRecord,
} from '@jozo-harness/session'
import { Effect } from 'effect'
import { persistenceError } from './errors.ts'
import { readHead } from './head.ts'
import { readZstdHead } from './zstd-log.ts'

export { TITLE_MAX_CHARS } from '@jozo-harness/session'

/** How much of a log is read to find the name the session carries. */
export const TITLE_READ_BYTES = 64 * 1024

/**
 * The names one line of a log carries. A torn line carries none; the next one may.
 * Most lines are neither a title nor a message, and are skipped without a parse.
 */
const candidatesOfLine = (line: string): ReadonlyArray<TitleCandidate> => {
  if (!line.includes('"session/title"') && !line.includes('"user/message"')) return []
  let record: { readonly type?: unknown; readonly data?: unknown }
  try {
    record = JSON.parse(line) as { readonly type?: unknown; readonly data?: unknown }
  } catch {
    return []
  }
  const written = titleEventOfRecord(record.type, record.data)
  const first = titleOfRecord(record.type, record.data)
  return [
    ...(written === undefined ? [] : [{ title: written.title, rank: TITLE_RANK[written.source] }]),
    ...(first === undefined || first === ''
      ? []
      : [{ title: first, rank: FIRST_MESSAGE_TITLE_RANK }]),
  ]
}

/** The name a stretch of log text carries; '' when it carries none. */
const titleOfText = (text: string): string => {
  let best: TitleCandidate | undefined
  for (const line of text.split('\n')) {
    for (const candidate of candidatesOfLine(line)) {
      best = betterTitle(best, candidate)
    }
  }
  return best?.title ?? ''
}

/**
 * The name of a plaintext log, read without carrying the rest: a listing names a
 * session without reading the ten thousand events behind it. A human's name wins,
 * then the model's, then the fallback, then the first message; a log whose words
 * sit past the budget stays unnamed rather than read whole. The model's name is
 * written before the answer of the first step, so the head holding the first
 * message also holds it.
 */
export const readTitle = (
  path: string,
  maxBytes: number = TITLE_READ_BYTES,
): Effect.Effect<string, SessionError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readHead(path, maxBytes),
      catch: (cause) => persistenceError(`cannot read ${path}`, cause),
    })
    return titleOfText(text)
  })

/** The name of a zstd log, decoded from the frames that fit in the head. */
export const readZstdTitle = (
  path: string,
  maxBytes: number = TITLE_READ_BYTES,
): Effect.Effect<string, SessionError> =>
  Effect.gen(function* () {
    const head = yield* Effect.tryPromise({
      try: () => readZstdHead(path, maxBytes),
      catch: (cause) => persistenceError(`cannot read ${path}`, cause),
    })
    return titleOfText(head.text)
  })
