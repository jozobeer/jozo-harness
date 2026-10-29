import { Effect } from 'effect'
import { FileSystem } from '@jozo-harness/filesystem'
import { ToolError } from '@jozo-harness/tools'

const decoder = new TextDecoder('utf-8', { fatal: true })

/** Reads a file as UTF-8 text; anything that is not UTF-8 is refused, not replaced. */
export const readUtf8 = (path: string): Effect.Effect<string, ToolError, FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const bytes = yield* fileSystem.readBytes(path).pipe(Effect.mapError(() => readFailed(path)))
    return yield* decodeText(bytes, path)
  })

const readFailed = (path: string): ToolError =>
  new ToolError({ code: 'execution', message: 'cannot read ' + path })

const decodeText = (bytes: Uint8Array, path: string): Effect.Effect<string, ToolError> =>
  Effect.try({
    try: () => decoder.decode(bytes),
    catch: () => new ToolError({ code: 'execution', message: 'not a UTF-8 text file: ' + path }),
  })

/** The lines of a file, without the empty line a trailing newline would add. */
export const linesOf = (text: string): ReadonlyArray<string> => {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** One line ending everywhere, so a match never depends on the platform that wrote it. */
export const normalizeNewlines = (text: string): string => text.replace(/\r\n/g, '\n')

/** The ending style the file on disk used; an edit writes it back the way it found it. */
export type LineEndings = 'LF' | 'CRLF'

/** A file decoded for editing, plus the style its lines must go back as. */
export interface EditText {
  readonly text: string
  readonly lineEndings: LineEndings
}

/**
 * Reads a file for editing. A NUL byte means binary and is refused before anything
 * is decoded; the text comes back LF-normalized so a match never depends on the
 * platform, and the caller restores the original ending on the way back out.
 */
export const readForEdit = (path: string): Effect.Effect<EditText, ToolError, FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const bytes = yield* fileSystem.readBytes(path).pipe(Effect.mapError(() => readFailed(path)))
    if (bytes.includes(0)) {
      return yield* Effect.fail(
        new ToolError({ code: 'execution', message: 'cannot edit ' + path + ': binary file' }),
      )
    }
    const raw = yield* decodeText(bytes, path)
    return {
      text: normalizeNewlines(raw),
      lineEndings: raw.includes('\r\n') ? 'CRLF' : 'LF',
    }
  })

/** Writes normalized text back in the ending style the file had. */
export const restoreLineEndings = (text: string, endings: LineEndings): string =>
  endings === 'LF' ? text : normalizeNewlines(text).split('\n').join('\r\n')
