import { Context, Effect, Layer, Schema } from 'effect'
import type { Plugin } from '@jozo-harness/kernel'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

/** The reads one call may ask for. Rename and diagnostics stay out, as in dsh. */
export const LSP_ACTIONS = ['definition', 'references', 'implementation', 'hover'] as const

export type LspAction = (typeof LSP_ACTIONS)[number]

/** The extensions this run can map to a server, so a refusal can name what it would have started. */
const LANGUAGES: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.py': 'python',
  '.go': 'gopls',
  '.rs': 'rust-analyzer',
}

/** The extension a path ends with, or the empty string when it has none. */
const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  return dot > slash ? path.slice(dot) : ''
}

/** The server this run would start for a path, when it knows the extension at all. */
export const languageFor = (path: string): string | undefined => LANGUAGES[extensionOf(path)]

/** One position in a file, 1-based as every tool argument and result is. */
export interface LspPosition {
  readonly line: number
  readonly column: number
}

export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

/** One place an action pointed at, in the one shape every action returns. */
export interface LspResult {
  readonly uri: string
  readonly range: LspRange
  readonly text: string
}

/** A location as a language server reports it: 0-based lines and UTF-16 columns. */
export interface LspWireLocation {
  readonly uri: string
  readonly range: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
}

/**
 * Turns a server's location into the tool's own shape. Servers count from 0 and
 * the tool from 1, so the shift happens here once, where a reader can see it.
 */
export const normalizeLocation = (location: LspWireLocation, text: string): LspResult => ({
  uri: location.uri,
  range: {
    start: {
      line: location.range.start.line + 1,
      column: location.range.start.character + 1,
    },
    end: {
      line: location.range.end.line + 1,
      column: location.range.end.character + 1,
    },
  },
  text,
})

const Position = Schema.Struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: 'The line of the position, counting from 1.',
  }),
  column: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: 'The column of the position, counting from 1.',
  }),
})

const Result = Schema.Struct({
  uri: Schema.String,
  range: Schema.Struct({ start: Position, end: Position }),
  text: Schema.String,
})

const Parameters = Schema.Struct({
  action: Schema.Literals(LSP_ACTIONS).annotate({
    description:
      'definition finds where a symbol is declared; references finds every use; implementation finds what implements it; hover returns what the server says about it.',
  }),
  path: Schema.String.annotate({ description: 'The file to ask about.' }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: 'The line of the position, counting from 1.',
  }),
  column: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: 'The column of the position, counting from 1.',
  }),
})

export type LspArgs = Schema.Schema.Type<typeof Parameters>

/** The decoded call shape, for a caller that checks arguments without the tool. */
export const lspParameters = Parameters

/** What one call leaves behind: the action it made and the places it found. */
export interface LspValue {
  readonly action: LspAction
  readonly results: ReadonlyArray<LspResult>
}

/**
 * Why this run cannot answer. The extension names both the problem and the
 * server a later slice will start, so the model knows the call was understood.
 */
const unavailable = (path: string): ToolError => {
  const extension = extensionOf(path)
  const language = languageFor(path)
  const named = extension === '' ? 'a file with no extension' : extension
  return new ToolError({
    code: 'unavailable',
    message:
      language === undefined
        ? 'no language server for ' + named + ' in this run'
        : 'no language server for ' + named + ' (' + language + ') in this run',
  })
}

const positionText = (range: LspRange): string =>
  String(range.start.line) + ':' + String(range.start.column)

/** Reads definitions, references, implementations, and hover text through a language server. */
export const lspTool: ToolDefinition<LspArgs, LspValue> = {
  name: 'lsp',
  presentCall: (args) => ({
    summary: args.action + ' ' + args.path + ':' + String(args.line) + ':' + String(args.column),
  }),
  presentResult: (args, result) => ({
    ...result,
    summary: args.action + ' ' + args.path,
  }),
  description:
    'Asks the language server for a file what a symbol is defined as, where it is referenced, what implements it, or what the server says about it. Answers with places a reader can open; a file with no server in this run says so instead of failing the call.',
  parameters: Parameters,
  // A read of the server is safe to run beside another read.
  isConcurrencySafe: () => true,
  output: {
    schema: Schema.Struct({ action: Schema.Literals(LSP_ACTIONS), results: Schema.Array(Result) }),
    render: (_args, value) =>
      value.results.length === 0
        ? [{ type: 'text', text: '(no results)' }]
        : [
            {
              type: 'text',
              text: value.results
                .map((each) => each.uri + ':' + positionText(each.range) + ' ' + each.text)
                .join('\n'),
            },
          ],
  },
  execute: (args) => Effect.fail(unavailable(args.path)),
}

/** The tools the lsp row hands the model. */
export const lspTools: ReadonlyArray<ToolDefinition<any, any>> = [lspTool]

/** The lsp tools the profile asked for; a run without the row keeps them out. */
export class LspTools extends Context.Service<LspTools, ReadonlyArray<ToolDefinition<any, any>>>()(
  'jozo-harness/LspTools',
) {}

export const lspPlugin: Plugin<{}, LspTools, never> = {
  name: '@jozo-harness/lsp',
  config: Schema.Struct({}),
  provides: [LspTools],
  requires: [],
  layer: () => Layer.succeed(LspTools, lspTools),
}
