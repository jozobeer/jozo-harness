import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import type { Plugin } from '@jozo-harness/kernel'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description:
      'The page file name without .html: letters, digits, dots, dashes, and underscores only.',
  }),
  html: Schema.String.annotate({
    description: 'The whole HTML document, with its styles and scripts inline.',
  }),
})

export type ArtifactArgs = Schema.Schema.Type<typeof Parameters>

export interface ArtifactValue {
  readonly sessionId: string
  readonly name: string
  readonly path: string
  readonly url: string
}

/** The same file-name rule the web route applies, so a written page is always reachable. */
const NAME = /^[A-Za-z0-9._-]+$/

/**
 * Writes one HTML page beside the session logs and reports the route the web
 * server serves it on. The route appends .html, so the name is the base name.
 */
export const makeArtifactTool = (home: string): ToolDefinition<ArtifactArgs, ArtifactValue> => ({
  name: 'artifact',
  description:
    'Publishes one self-contained HTML page for this session and returns the /artifact/ URL jzh web serves it on. Use it for reports, diagrams, and tables that read better as a page than as chat text. Writing the same name again replaces the page.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      sessionId: Schema.String,
      name: Schema.String,
      path: Schema.String,
      url: Schema.String,
    }),
    render: (_args, value) => [{ type: 'text', text: 'page: ' + value.url }],
  },
  execute: (args, exec) =>
    Effect.gen(function* () {
      if (!NAME.test(args.name) || args.name.includes('..')) {
        return yield* Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message:
              'an artifact name is letters, digits, dots, dashes, and underscores: ' + args.name,
          }),
        )
      }
      const directory = join(home, 'artifacts', exec.sessionId)
      const path = join(directory, args.name + '.html')
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(directory, { recursive: true })
          await writeFile(path, args.html)
        },
        catch: () =>
          new ToolError({ code: 'execution', message: 'cannot write the page at ' + path }),
      })
      const url = '/artifact/' + exec.sessionId + '/' + args.name
      // The model reads the URL now, so a later request still knows where the page is.
      exec.addContext?.(url)
      return { sessionId: exec.sessionId, name: args.name, path, url }
    }),
})

/**
 * The artifact tool, ready for whoever registers tools into the registry. It
 * takes the jzh home from the run, so the page lands beside the sessions root.
 */
export class ArtifactTools extends Context.Service<
  ArtifactTools,
  (home: string) => ReadonlyArray<ToolDefinition<any, any>>
>()('jozo-harness/ArtifactTools') {}

/** Loader definition for the artifact tool; the row opts a session into writing pages. */
export const artifactPlugin: Plugin<{}, ArtifactTools, never> = {
  name: '@jozo-harness/artifact',
  config: Schema.Struct({}),
  provides: [ArtifactTools],
  requires: [],
  layer: () => Layer.succeed(ArtifactTools, (home) => [makeArtifactTool(home)]),
}
