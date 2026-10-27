import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import type { Plugin } from '@jozo-harness/kernel'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import { ToolError, type ToolDefinition, type ToolRunContext } from '@jozo-harness/tools'
import { mediaTypeOf } from './image.ts'

const Deliverable = Schema.Struct({
  path: Schema.String.annotate({
    description: 'An existing file inside the working directory to declare as a deliverable.',
  }),
  title: Schema.optionalKey(
    Schema.String.annotate({ description: 'A short name shown for the declared file.' }),
  ),
})

const Parameters = Schema.Struct({
  name: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The page file name without .html: letters, digits, dots, dashes, and underscores only.',
    }),
  ),
  html: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The whole HTML document, with its styles and scripts inline.',
    }),
  ),
  images: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        'Image files to embed as data URLs, absolute or relative to the working directory: png, jpeg, webp, or gif.',
    }),
  ),
  deliverable: Schema.optionalKey(
    Deliverable.annotate({
      description: "A file to declare as this turn's deliverable instead of publishing a page.",
    }),
  ),
})

export type ArtifactArgs = Schema.Schema.Type<typeof Parameters>

export interface ArtifactValue {
  readonly sessionId: string
  readonly name: string
  readonly path: string
  readonly url: string
}

export interface DeliverableValue {
  readonly path: string
  readonly title?: string
}

export type ArtifactResult = ArtifactValue | DeliverableValue

/** The same file-name rule the web route applies, so a written page is always reachable. */
const NAME = /^[A-Za-z0-9._-]+$/

/**
 * Artifacts live beside the sessions root, under the same parent, so a changed
 * root moves both what the tool writes and what the web server serves.
 */
export const artifactRootOf = (sessionRoot: string): string =>
  join(dirname(sessionRoot), 'artifacts')

/** The per-image and per-page budgets keep a page small enough to download. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024

interface EmbeddedImage {
  /** The path as the model wrote it, which is what the page's src also says. */
  readonly given: string
  readonly bytes: number
  readonly dataUrl: string
}

const readImage = (cwd: string, given: string): Effect.Effect<EmbeddedImage, ToolError> =>
  Effect.gen(function* () {
    const mediaType = mediaTypeOf(given)
    if (mediaType === undefined) {
      return yield* Effect.fail(
        new ToolError({ code: 'invalid-arguments', message: 'not a supported image: ' + given }),
      )
    }
    const path = given.startsWith('/') ? given : join(cwd, given)
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(path),
      catch: () => new ToolError({ code: 'invalid-arguments', message: 'cannot read ' + given }),
    })
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return yield* Effect.fail(
        new ToolError({
          code: 'invalid-arguments',
          message: 'image over the 2MB limit: ' + given,
        }),
      )
    }
    return {
      given,
      bytes: bytes.byteLength,
      dataUrl: 'data:' + mediaType + ';base64,' + Buffer.from(bytes).toString('base64'),
    }
  })

const readImages = (
  cwd: string,
  given: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<EmbeddedImage>, ToolError> =>
  Effect.gen(function* () {
    const images: Array<EmbeddedImage> = []
    let total = 0
    for (const path of given) {
      const image = yield* readImage(cwd, path)
      total += image.bytes
      if (total > MAX_TOTAL_BYTES) {
        return yield* Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'images over the 10MB total: ' + image.given,
          }),
        )
      }
      images.push(image)
    }
    return images
  })

/**
 * A page stays standalone only while it names every file itself. These are the
 * elements and attributes a browser loads as a subresource, so an http(s) or
 * protocol-relative value there pulls a file from outside the page.
 */
const SUBRESOURCE_ATTRIBUTES: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['img', ['src']],
  ['script', ['src']],
  ['link', ['href']],
  ['iframe', ['src']],
  ['video', ['src', 'poster']],
  ['audio', ['src']],
  ['source', ['src']],
  ['object', ['data']],
])

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

interface Reference {
  readonly attribute: string
  readonly value: string
}

const tagsOf = (html: string): ReadonlyArray<{ name: string; body: string }> =>
  Array.from(html.matchAll(TAG), ([, name = '', body = '']) => ({
    name: name.toLowerCase(),
    body,
  }))

const attributesOf = (body: string): ReadonlyArray<[string, string]> =>
  Array.from(
    body.matchAll(ATTRIBUTE),
    ([, name = '', double = '', single = '', bare = '']): [string, string] => [
      name.toLowerCase(),
      double || single || bare,
    ],
  )

/** The subresource references the page makes, in document order. */
const references = (html: string): ReadonlyArray<Reference> =>
  tagsOf(html).flatMap((tag) => {
    const wanted = SUBRESOURCE_ATTRIBUTES.get(tag.name) ?? []
    return attributesOf(tag.body)
      .filter(([attribute]) => wanted.includes(attribute))
      .map(([attribute, value]) => ({ attribute, value }))
  })

/** The value that leaves the document, or undefined while the page stands alone. */
const outsideReference = (html: string): string | undefined => {
  for (const reference of references(html)) {
    if (/^(?:https?:\/\/|\/\/)/i.test(reference.value)) return reference.value
  }
  return undefined
}

/** The src values the page names, which are the places foldImages fills in. */
const namedSources = (html: string): ReadonlyArray<string> =>
  references(html)
    .filter((reference) => reference.attribute === 'src')
    .map((reference) => reference.value)

/** The first image the page never names, which would leave an unread file behind. */
const unreferencedImage = (html: string, images: ReadonlyArray<string>): string | undefined => {
  const sources = namedSources(html)
  return images.find((given) => !sources.includes(given) && !sources.includes(basename(given)))
}

/**
 * Folds each referenced file into a data URL. An image the page never names is
 * left as given; refusing it belongs to the standalone check, not here.
 */
const foldImages = (html: string, images: ReadonlyArray<EmbeddedImage>): string => {
  const bySrc = new Map<string, string>()
  for (const image of images) {
    bySrc.set(image.given, image.dataUrl)
    bySrc.set(basename(image.given), image.dataUrl)
  }
  return html.replace(/src="([^"]*)"/g, (whole, src: string) => {
    const dataUrl = bySrc.get(src)
    return dataUrl === undefined ? whole : 'src="' + dataUrl + '"'
  })
}

/** True only for a path strictly below the root, so the root itself and its siblings stay out. */
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/**
 * Declares an existing file without copying it. The real path of both the
 * working directory and the file decide containment, so a symlink cannot
 * declare a file the workspace does not hold.
 */
const declareDeliverable = (
  deliverable: { readonly path: string; readonly title?: string },
  exec: ToolRunContext,
): Effect.Effect<DeliverableValue, ToolError> =>
  Effect.gen(function* () {
    const target = resolve(exec.cwd, deliverable.path)
    const root = yield* Effect.tryPromise({
      try: () => realpath(exec.cwd),
      catch: () =>
        new ToolError({
          code: 'invalid-arguments',
          message: 'cannot read the working directory: ' + exec.cwd,
        }),
    })
    const file = yield* Effect.tryPromise({
      try: () => realpath(target),
      catch: () =>
        new ToolError({ code: 'invalid-arguments', message: 'no such file: ' + deliverable.path }),
    })
    if (!inside(root, file)) {
      return yield* Effect.fail(
        new ToolError({
          code: 'invalid-arguments',
          message: 'a deliverable must be inside the working directory: ' + deliverable.path,
        }),
      )
    }
    const info = yield* Effect.tryPromise({
      try: () => stat(file),
      catch: () =>
        new ToolError({ code: 'invalid-arguments', message: 'no such file: ' + deliverable.path }),
    })
    if (!info.isFile()) {
      return yield* Effect.fail(
        new ToolError({ code: 'invalid-arguments', message: 'not a file: ' + deliverable.path }),
      )
    }
    return {
      path: target,
      ...(deliverable.title === undefined ? {} : { title: deliverable.title }),
    }
  })

/**
 * Writes one HTML page beside the session logs and reports the route the web
 * server serves it on. The route and this tool derive the directory from the
 * same session root. The route appends .html, so the name is the base name.
 * The page sits outside the workspace, so the sandbox never wraps this write:
 * the mode is read here, and a read-only run publishes nothing.
 */
/** The name and html a page write needs, or why the call cannot name one. */
const pageRequest = (
  args: ArtifactArgs,
): Effect.Effect<{ readonly name: string; readonly html: string }, ToolError> => {
  if (args.name === undefined || args.html === undefined) {
    return Effect.fail(
      new ToolError({
        code: 'invalid-arguments',
        message: 'an artifact needs a name and html, or a deliverable path',
      }),
    )
  }
  if (!NAME.test(args.name) || args.name.includes('..')) {
    return Effect.fail(
      new ToolError({
        code: 'invalid-arguments',
        message: 'an artifact name is letters, digits, dots, dashes, and underscores: ' + args.name,
      }),
    )
  }
  return Effect.succeed({ name: args.name, html: args.html })
}

const publishPage = (
  sessionRoot: string,
  sandbox: SandboxShape,
  args: ArtifactArgs,
  exec: ToolRunContext,
): Effect.Effect<ArtifactValue, ToolError> =>
  Effect.gen(function* () {
    const { name, html: htmlArg } = yield* pageRequest(args)
    const directory = join(artifactRootOf(sessionRoot), exec.sessionId)
    const path = join(directory, name + '.html')
    if (sandbox.mode === 'read-only') {
      return yield* Effect.fail(
        new ToolError({ code: 'denied', message: 'read-only mode writes nothing: ' + path }),
      )
    }
    const outside = outsideReference(htmlArg)
    if (outside !== undefined) {
      return yield* Effect.fail(
        new ToolError({
          code: 'invalid-arguments',
          message: 'a page must not load files from outside itself: ' + outside,
        }),
      )
    }
    const given = args.images ?? []
    const images = yield* readImages(exec.cwd, given)
    const unused = unreferencedImage(htmlArg, given)
    if (unused !== undefined) {
      return yield* Effect.fail(
        new ToolError({
          code: 'invalid-arguments',
          message: 'the page never references this image: ' + unused,
        }),
      )
    }
    const html = foldImages(htmlArg, images)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(path, html)
      },
      catch: () =>
        new ToolError({ code: 'execution', message: 'cannot write the page at ' + path }),
    })
    const url = '/artifact/' + exec.sessionId + '/' + name
    // The model reads the URL now, so a later request still knows where the page is.
    exec.addContext?.(url)
    return { sessionId: exec.sessionId, name, path, url }
  })

/**
 * Publishes an HTML page or declares an existing workspace file as the
 * deliverable. A declaration writes nothing, so it needs no write permission.
 */
export const makeArtifactTool = (
  sessionRoot: string,
  sandbox: SandboxShape = noneSandbox,
): ToolDefinition<ArtifactArgs, ArtifactResult> => ({
  name: 'artifact',
  description:
    'Publishes one self-contained HTML page for this session and returns the /artifact/ URL jzh web serves it on, or declares an existing file inside the working directory as the deliverable. Use a page for reports, diagrams, and tables that read better as a page than as chat text, and a deliverable for a file the user should open. Pass image paths in images to embed them as data URLs. Writing the same name again replaces the page.',
  parameters: Parameters,
  output: {
    schema: Schema.Union([
      Schema.Struct({
        sessionId: Schema.String,
        name: Schema.String,
        path: Schema.String,
        url: Schema.String,
      }),
      Schema.Struct({ path: Schema.String, title: Schema.optionalKey(Schema.String) }),
    ]),
    render: (_args, value) => {
      if ('url' in value) return [{ type: 'text', text: 'page: ' + value.url }]
      return [{ type: 'text', text: 'deliverable: ' + value.path }]
    },
  },
  execute: (args, exec) =>
    args.deliverable === undefined
      ? publishPage(sessionRoot, sandbox, args, exec)
      : declareDeliverable(args.deliverable, exec),
})

/**
 * The artifact tool, ready for whoever registers tools into the registry. It
 * takes the sessions root from the run, so the page lands beside the logs.
 */
export class ArtifactTools extends Context.Service<
  ArtifactTools,
  (sessionRoot: string, sandbox: SandboxShape) => ReadonlyArray<ToolDefinition<any, any>>
>()('jozo-harness/ArtifactTools') {}

/** Loader definition for the artifact tool; the row opts a session into writing pages. */
export const artifactPlugin: Plugin<{}, ArtifactTools, never> = {
  name: '@jozo-harness/artifact',
  config: Schema.Struct({}),
  provides: [ArtifactTools],
  requires: [],
  layer: () =>
    Layer.succeed(ArtifactTools, (sessionRoot, sandbox) => [
      makeArtifactTool(sessionRoot, sandbox),
    ]),
}
