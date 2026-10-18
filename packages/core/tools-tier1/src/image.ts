import { readFile } from 'node:fs/promises'
import { Schema, Effect } from 'effect'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description:
      'The png, jpeg, webp, or gif file to show, absolute or relative to the working directory.',
  }),
})

export type ReadImageArgs = Schema.Schema.Type<typeof Parameters>

export interface ReadImageValue {
  readonly path: string
  readonly mediaType: string
  readonly bytes: number
  /** Base64 of the image, so the value alone is enough to render it. */
  readonly data: string
}

const MEDIA: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

const mediaTypeOf = (path: string): string | undefined => {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? undefined : MEDIA[path.slice(dot + 1).toLowerCase()]
}

/** Reads one image file and hands it to the model as an image block. */
export const readImageTool: ToolDefinition<ReadImageArgs, ReadImageValue> = {
  name: 'read_image',
  description:
    'Reads a png, jpeg, webp, or gif file and shows it to the model when the current route carries images; otherwise it fails and says why. Use it instead of read for images: read returns bytes as text.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      path: Schema.String,
      mediaType: Schema.String,
      bytes: Schema.Int,
      data: Schema.String,
    }),
    render: (_args, value) => [
      { type: 'image', mediaType: value.mediaType, data: value.data, name: value.path },
    ],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      if (context.images === 'none') {
        return yield* Effect.fail(
          new ToolError({
            code: 'execution',
            message:
              'read_image is unavailable: the current route cannot carry images; switch to an image-capable route to show one',
          }),
        )
      }
      const mediaType = mediaTypeOf(args.path)
      if (mediaType === undefined) {
        return yield* Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'not a supported image: ' + args.path,
          }),
        )
      }
      const path = args.path.startsWith('/') ? args.path : context.cwd + '/' + args.path
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(path),
        catch: () => new ToolError({ code: 'execution', message: 'cannot read ' + path }),
      })
      return {
        path,
        mediaType,
        bytes: bytes.byteLength,
        data: Buffer.from(bytes).toString('base64'),
      }
    }),
}
