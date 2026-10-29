import { matchesGlob } from 'node:path'
import { Schema, Effect } from 'effect'
import { FileSystem, withFileSystem, type FileSystemShape } from '@jozo-harness/filesystem'
import { ToolError, writeSpill, type ToolDefinition } from '@jozo-harness/tools'
import { takePage } from './page.ts'
import {
  defaultRipgrep,
  fallbackNote,
  findMatchesWithRipgrep,
  type Ripgrep,
  type RipgrepMatch,
} from './ripgrep.ts'
import { comparePaths, isBinary, walkFiles } from './walk.ts'
import { resolveSearchStart } from './workspace.ts'

/** A search stops collecting here; a broader pattern is reached by narrowing it. */
export const GREP_MAX_MATCHES = 20_000
/** The most files one search looks through before it stops. */
export const GREP_MAX_FILES = 20_000
/** The matches one result shows inline; a longer list reaches the model by its locator. */
export const GREP_PAGE_MATCHES = 250
/** A matched line longer than this is cut, so one line cannot fill the window. */
export const GREP_MAX_LINE_CHARS = 2000

const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({
    description: 'A regular expression to search for in each line.',
  }),
  path: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The directory to start the search in, absolute or relative to the workspace. Defaults to the workspace root.',
    }),
  ),
  include: Schema.optionalKey(
    Schema.String.annotate({
      description: "A glob that limits which files are read, for example 'src/**/*.ts'.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.annotate({ description: 'The most matches to show. Defaults to 250.' }),
  ),
})

export type GrepArgs = Schema.Schema.Type<typeof Parameters>

export interface GrepMatch {
  readonly file: string
  readonly line: number
  readonly text: string
}

export interface GrepValue {
  readonly matches: ReadonlyArray<GrepMatch>
  /** How many matches were found, before the page and the collection cap. */
  readonly seen: number
  readonly truncated: boolean
  /** Where the complete list was stored, when the page cannot show all of it. */
  readonly locator?: string
  /** Why the built-in walker ran instead of ripgrep, when it did. */
  readonly fallback?: string
}

/** One match a line, the shape the page, the stored file, and the byte budget all use. */
const matchLineOf = (match: GrepMatch): string =>
  match.file + ':' + String(match.line) + ': ' + match.text

const matchLines = (matches: ReadonlyArray<GrepMatch>): string =>
  matches.map(matchLineOf).join('\n')

/** The way back to a result the page could not hold. */
const recovery = (locator: string | undefined): string =>
  locator === undefined
    ? 'narrow the pattern to see the rest'
    : 'the full result is stored at ' +
      locator +
      '; use the read tool with offset and limit to page through it'

const noteOf = (fallback: string | undefined): string =>
  fallback === undefined ? '' : '\n' + fallbackNote(fallback)

/** A matched line of any length becomes a retained line of at most GREP_MAX_LINE_CHARS. */
const cutLine = (text: string): string =>
  text.length <= GREP_MAX_LINE_CHARS ? text : text.slice(0, GREP_MAX_LINE_CHARS) + ' ... (line cut)'

/** One file's matching lines, in order. */
const matchesIn = (file: string, text: string, expression: RegExp): ReadonlyArray<GrepMatch> => {
  const matches: Array<GrepMatch> = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (expression.test(line)) matches.push({ file, line: index + 1, text: cutLine(line) })
  }
  return matches
}

/** A file's text, or undefined when it is binary or not UTF-8; either way it has no lines to match. */
const searchableText = (path: string): Effect.Effect<string | undefined, never, FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const bytes = yield* fileSystem.readBytes(path).pipe(Effect.orElseSucceed(() => undefined))
    if (bytes === undefined || isBinary(bytes)) return undefined
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return undefined
    }
  })

/** Walks the files in order and stops one match past the limit, which is all the caller needs. */
const findMatches = (
  files: ReadonlyArray<string>,
  cwd: string,
  expression: RegExp,
  limit: number,
): Effect.Effect<ReadonlyArray<GrepMatch>, never, FileSystem> =>
  Effect.gen(function* () {
    const matches: Array<GrepMatch> = []
    for (const file of files) {
      if (matches.length > limit) break
      const text = yield* searchableText(cwd + '/' + file)
      if (text === undefined) continue
      matches.push(...matchesIn(file, text, expression))
    }
    return matches
  })

const compile = (pattern: string): Effect.Effect<RegExp, ToolError> =>
  Effect.try({
    try: () => new RegExp(pattern),
    catch: () => new ToolError({ code: 'invalid-arguments', message: 'bad pattern: ' + pattern }),
  })

/** Path order, then line order, so both backends report the same list. */
const inPathOrder = (matches: ReadonlyArray<GrepMatch>): ReadonlyArray<GrepMatch> =>
  [...matches].sort((left, right) => comparePaths(left.file, right.file) || left.line - right.line)

const cutMatches = (matches: ReadonlyArray<RipgrepMatch>): ReadonlyArray<GrepMatch> =>
  matches.map((match) => ({ ...match, text: cutLine(match.text) }))

interface FoundMatches {
  readonly found: ReadonlyArray<GrepMatch>
  readonly fallback?: string
}

/** ripgrep when it answers, otherwise the walker the run had before ripgrep was optional. */
const searchMatches = (
  args: GrepArgs,
  cwd: string,
  start: string,
  expression: RegExp,
  ripgrep: Ripgrep,
): Effect.Effect<FoundMatches, never, FileSystem> =>
  Effect.gen(function* () {
    const include = args.include
    const direct = yield* Effect.promise(() =>
      findMatchesWithRipgrep(
        {
          cwd,
          start,
          pattern: args.pattern,
          limit: GREP_MAX_MATCHES + 1,
          ...(include === undefined
            ? {}
            : { accept: (file: string) => matchesGlob(file, include) }),
        },
        ripgrep,
      ),
    )
    if (direct.fallback === undefined) return { found: cutMatches(direct.matches) }
    const files = yield* walkFiles({
      cwd,
      limit: GREP_MAX_FILES,
      start,
      ...(include === undefined ? {} : { pattern: include }),
    })
    const found = yield* findMatches(files, cwd, expression, GREP_MAX_MATCHES + 1)
    return { found, fallback: direct.fallback }
  })

/**
 * Searches workspace files line by line with a regular expression. ripgrep
 * answers when PATH has it, which keeps nested .gitignore rules and binary
 * files out; a run without it says why it fell back to the walker.
 */
export const makeGrepTool = (
  fileSystem: FileSystemShape,
  ripgrep: Ripgrep = defaultRipgrep,
): ToolDefinition<GrepArgs, GrepValue> => ({
  name: 'grep',
  readOnly: true,
  presentCall: (args) => ({ summary: 'grep ' + args.pattern }),
  description:
    'Searches workspace files for a regular expression and returns file, line, and text for each match. Use it instead of shelling out to grep or rg. Dot-entries such as .github are searched; only node_modules, .git, and binary files are skipped. ripgrep respects nested .gitignore files; without rg, the fallback reads only the workspace-root rules and says so. A result too long to show is stored whole; read that file with offset and limit.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      matches: Schema.Array(
        Schema.Struct({ file: Schema.String, line: Schema.Int, text: Schema.String }),
      ),
      seen: Schema.Int,
      truncated: Schema.Boolean,
      locator: Schema.optionalKey(Schema.String),
      fallback: Schema.optionalKey(Schema.String),
    }),
    render: (_args, value) => {
      const body = matchLines(value.matches) + noteOf(value.fallback)
      if (!value.truncated) return [{ type: 'text', text: body }]
      return [
        {
          type: 'text',
          text:
            body +
            '\n... (showing ' +
            String(value.matches.length) +
            ' of ' +
            String(value.seen) +
            ' matches; ' +
            recovery(value.locator) +
            ')',
        },
      ]
    },
  },
  execute: (args, context) =>
    withFileSystem(
      fileSystem,
      Effect.gen(function* () {
        // The pattern is compiled before a single file is read.
        const expression = yield* compile(args.pattern)
        const page = args.limit ?? GREP_PAGE_MATCHES
        if (page < 1) {
          return yield* Effect.fail(
            new ToolError({ code: 'invalid-arguments', message: 'limit starts at 1' }),
          )
        }
        const start = yield* resolveSearchStart(fileSystem, context.cwd, args.path)
        const { found, fallback } = yield* searchMatches(
          args,
          context.cwd,
          start,
          expression,
          ripgrep,
        )
        const complete = inPathOrder(found).slice(0, GREP_MAX_MATCHES)
        const shown = takePage(complete, page, matchLineOf)
        const note = fallback === undefined ? {} : { fallback }
        if (found.length <= shown.length) {
          return { matches: shown, seen: found.length, truncated: false, ...note }
        }
        const locator = yield* writeSpill(context, 'grep', matchLines(complete))
        return {
          matches: shown,
          seen: found.length,
          truncated: true,
          ...(locator === undefined ? {} : { locator }),
          ...note,
        }
      }),
    ),
})
