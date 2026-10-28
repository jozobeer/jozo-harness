import { Schema, Effect } from 'effect'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { look, type ObservedFiles } from './observed-files.ts'
import { linesOf, readUtf8 } from './text.ts'
import { rangeOf } from './present.ts'

/** One line longer than this many characters is cut, so one line cannot fill the window. */
export const READ_MAX_LINE_CHARS = 2000
/** A window stops once it holds this many bytes of lines; the scan still counts every line. */
export const READ_MAX_BYTES = 50 * 1024

const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description: 'The file to read, absolute or relative to the working directory.',
  }),
  offset: Schema.optionalKey(
    Schema.Int.annotate({ description: 'First line to return, 1-based. Defaults to 1.' }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.annotate({ description: 'How many lines to return. Defaults to 2000.' }),
  ),
})

export type ReadArgs = Schema.Schema.Type<typeof Parameters>

export interface ReadValue {
  /** The numbered lines of the window, without a footer. */
  readonly text: string
  readonly totalLines: number
  /** First line of the window, 1-based. 0 when the file is empty. */
  readonly from: number
  /** Last line of the window, 1-based. 0 when the file is empty. */
  readonly to: number
  /** More lines follow this window. */
  readonly truncated: boolean
  /** The window stopped at the byte cap rather than at the line limit. */
  readonly capped: boolean
  /** How many lines were cut to the line cap. */
  readonly shortened: number
}

interface Window {
  readonly text: string
  readonly to: number
  readonly truncated: boolean
  readonly capped: boolean
  readonly shortened: number
}

/** A line of any length becomes a line of at most READ_MAX_LINE_CHARS, saying so. */
const cutLine = (raw: string): { readonly text: string; readonly shortened: boolean } =>
  raw.length > READ_MAX_LINE_CHARS
    ? {
        text:
          raw.slice(0, READ_MAX_LINE_CHARS) +
          '... (line truncated to ' +
          READ_MAX_LINE_CHARS +
          ' chars)',
        shortened: true,
      }
    : { text: raw, shortened: false }

/** One file line as the model reads it: numbered, cut to the line cap, single-line. */
const numberedLine = (
  raw: string,
  number: number,
): { readonly line: string; readonly shortened: boolean } => {
  const cut = cutLine(raw)
  return { line: String(number) + '\t' + cut.text, shortened: cut.shortened }
}

/** The window as it is being cut: lines kept, their bytes, and what had to give. */
interface WindowAccumulator {
  readonly kept: Array<string>
  bytes: number
  shortened: number
  capped: boolean
}

/** Adds one line if it still fits, or marks the window capped. */
const takeLine = (window: WindowAccumulator, raw: string, number: number): void => {
  const built = numberedLine(raw.replace(/\r$/, ''), number)
  if (built.shortened) window.shortened += 1
  const size = Buffer.byteLength(built.line, 'utf8') + (window.kept.length === 0 ? 0 : 1)
  if (window.bytes + size > READ_MAX_BYTES) {
    window.capped = true
    return
  }
  window.bytes += size
  window.kept.push(built.line)
}

/** Cuts one window out of the file lines, under the line and byte caps. */
const windowed = (lines: ReadonlyArray<string>, offset: number, limit: number): Window => {
  const window: WindowAccumulator = { kept: [], bytes: 0, shortened: 0, capped: false }

  for (
    let index = offset - 1;
    index < lines.length && !window.capped && window.kept.length < limit;
    index += 1
  ) {
    takeLine(window, lines[index] ?? '', index + 1)
  }

  const to = offset - 1 + window.kept.length
  return {
    text: window.kept.join('\n'),
    to,
    truncated: to < lines.length,
    capped: window.capped,
    shortened: window.shortened,
  }
}

/** The line that tells the model whether it has seen the whole file. */
const footer = (value: ReadValue): string => {
  if (!value.truncated) return '(End of file - total ' + value.totalLines + ' lines)'
  const capped = value.capped ? 'Output capped. ' : ''
  const of = value.capped ? '' : ' of ' + value.totalLines
  return (
    '(' +
    capped +
    'Showing lines ' +
    value.from +
    '-' +
    value.to +
    of +
    '. Continue with offset=' +
    (value.to + 1) +
    '.)'
  )
}

/** Refuses a window that cannot exist, before any line is rendered. */
const checkWindow = (
  path: string,
  offset: number,
  limit: number,
  totalLines: number,
): Effect.Effect<void, ToolError> => {
  if (offset < 1 || limit < 1) {
    return Effect.fail(
      new ToolError({
        code: 'invalid-arguments',
        message:
          'offset and limit start at 1: offset=' + String(offset) + ' limit=' + String(limit),
      }),
    )
  }
  if (offset > totalLines && !(totalLines === 0 && offset === 1)) {
    return Effect.fail(
      new ToolError({
        code: 'invalid-arguments',
        message:
          'offset ' +
          String(offset) +
          ' is past the end of ' +
          path +
          ' (' +
          String(totalLines) +
          ' lines)',
      }),
    )
  }
  return Effect.void
}

/**
 * Reads one UTF-8 text file. Line numbers are 1-based, like an editor. What it
 * read is remembered for the session, so a later write or edit can tell whether
 * somebody else changed the file in between.
 */
export const makeReadTool = (observed: ObservedFiles): ToolDefinition<ReadArgs, ReadValue> => ({
  name: 'read',
  readOnly: true,
  presentCall: (args) => ({ summary: 'read ' + rangeOf(args) }),
  description:
    'Reads a UTF-8 text file and returns its lines with 1-based line numbers. Use it instead of cat, head, or tail. When the footer says more lines follow, call read again with offset; a file whose output was spilled is read the same way.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      text: Schema.String,
      totalLines: Schema.Int,
      from: Schema.Int,
      to: Schema.Int,
      truncated: Schema.Boolean,
      capped: Schema.Boolean,
      shortened: Schema.Int,
    }),
    render: (_args, value) => [
      {
        type: 'text',
        text: value.text === '' ? footer(value) : value.text + '\n\n' + footer(value),
      },
    ],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const path = args.path.startsWith('/') ? args.path : context.cwd + '/' + args.path
      const offset = args.offset ?? 1
      const limit = args.limit ?? 2000
      const lines = linesOf(yield* readUtf8(path))
      yield* checkWindow(path, offset, limit, lines.length)
      const window = windowed(lines, offset, limit)
      const current = yield* look(path)
      if (current !== undefined) observed.observe(context.sessionId, path, current)
      return {
        text: window.text,
        totalLines: lines.length,
        from: lines.length === 0 ? 0 : offset,
        to: window.to,
        truncated: window.truncated,
        capped: window.capped,
        shortened: window.shortened,
      }
    }),
})
