import { Schema, Effect } from 'effect'
import { ToolError, writeSpill, type ToolDefinition } from '@jozo-harness/tools'
import { takePage } from './page.ts'
import { walkFiles } from './walk.ts'
import { resolveSearchStart } from './workspace.ts'

/** A glob stops collecting here; the walk is bounded so a broad pattern cannot run forever. */
export const GLOB_MAX_PATHS = 20_000
/** The paths one result shows inline; a longer list reaches the model by its locator. */
export const GLOB_PAGE_PATHS = 100

const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "The glob to match against workspace paths, for example '**/*.ts'.",
  }),
  path: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The directory to start the walk in, absolute or relative to the workspace. Defaults to the workspace root.',
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.annotate({ description: 'The most paths to show. Defaults to 100.' }),
  ),
})

export type GlobArgs = Schema.Schema.Type<typeof Parameters>

export interface GlobValue {
  readonly files: ReadonlyArray<string>
  /** How many paths matched, before the page and the collection cap. */
  readonly seen: number
  readonly truncated: boolean
  /** Where the complete list was stored, when the page cannot show all of it. */
  readonly locator?: string
}

/** The way back to a result the page could not hold. */
const recovery = (locator: string | undefined): string =>
  locator === undefined
    ? 'narrow the pattern to see the rest'
    : 'the full sorted result is stored at ' +
      locator +
      '; use the read tool with offset and limit to page through it'

const renderGlob = (
  value: GlobValue,
): ReadonlyArray<{ readonly type: 'text'; readonly text: string }> => {
  const body = value.files.join('\n')
  if (!value.truncated) return [{ type: 'text', text: body }]
  return [
    {
      type: 'text',
      text:
        body +
        '\n... (showing ' +
        String(value.files.length) +
        ' of ' +
        String(value.seen) +
        ' paths; ' +
        recovery(value.locator) +
        ')',
    },
  ]
}

/** Lists workspace files whose relative path matches a glob, newest modification last. Dot-entries are walked; .git and node_modules are not. */
export const globTool: ToolDefinition<GlobArgs, GlobValue> = {
  name: 'glob',
  presentCall: (args) => ({ summary: 'glob ' + args.pattern }),
  description:
    'Lists workspace files matching a glob pattern, in modification-time order (oldest first). Use it to find files by name; use grep to search inside them. Dot-entries such as .github are walked; only node_modules and .git are never walked. A list too long to show is stored whole; read that file with offset and limit.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      files: Schema.Array(Schema.String),
      seen: Schema.Int,
      truncated: Schema.Boolean,
      locator: Schema.optionalKey(Schema.String),
    }),
    render: (_args, value) => renderGlob(value),
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const page = args.limit ?? GLOB_PAGE_PATHS
      if (page < 1) {
        return yield* Effect.fail(
          new ToolError({ code: 'invalid-arguments', message: 'limit starts at 1' }),
        )
      }
      const start = yield* resolveSearchStart(context.cwd, args.path)
      // One path past the collection cap is enough to know the walk was stopped.
      const found = yield* walkFiles({
        cwd: context.cwd,
        limit: GLOB_MAX_PATHS + 1,
        pattern: args.pattern,
        order: 'modified',
        start,
      })
      const complete = found.slice(0, GLOB_MAX_PATHS)
      const shown = takePage(complete, page, (path) => path)
      if (found.length <= shown.length)
        return { files: shown, seen: found.length, truncated: false }
      const locator = yield* writeSpill(context, 'glob', complete.join('\n'))
      return {
        files: shown,
        seen: found.length,
        truncated: true,
        ...(locator === undefined ? {} : { locator }),
      }
    }),
}
