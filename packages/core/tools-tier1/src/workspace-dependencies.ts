import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import type { Plugin } from '@jozo-harness/kernel'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

/** The runtimes a payload may ship; the order is the one the tool reports. */
export const RUNTIMES = ['python', 'node', 'pnpm'] as const

export type RuntimeName = (typeof RUNTIMES)[number]

/**
 * The payload's own description. Entries are relative to the payload, so a
 * deployment can move the directory without rewriting what it holds.
 */
const Manifest = Schema.Struct({
  python: Schema.String,
  node: Schema.optionalKey(Schema.String),
  pnpm: Schema.optionalKey(Schema.String),
})

export type WorkspaceDependencyManifest = Schema.Schema.Type<typeof Manifest>

/**
 * What the model needs to run a pinned runtime: absolute paths into the payload,
 * and the names the payload does not ship so a missing runtime is not guessed at.
 */
export interface WorkspaceDependenciesValue {
  readonly root: string
  readonly python: string
  readonly node?: string
  readonly pnpm?: string
  readonly missing: ReadonlyArray<RuntimeName>
}

const unavailable = (message: string): ToolError =>
  new ToolError({
    code: 'unavailable',
    message: 'workspace_dependencies is unavailable: ' + message,
  })

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A settings file may write the jzh directory it owns as `~`, like the sessions root. */
export const expandHome = (path: string): string =>
  path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

/**
 * The path a manifest entry names inside the payload, or undefined when it leaves
 * it: an absolute entry or one that climbs above the root would hand the model a
 * file this installation does not ship.
 */
export const containedPath = (root: string, entry: string): string | undefined => {
  if (entry === '' || isAbsolute(entry)) return undefined
  const path = resolve(root, entry)
  return path.startsWith(root + sep) ? path : undefined
}

/** Resolves one entry to the executable it names, refusing anything the payload does not hold. */
const runtimePath = (
  root: string,
  name: RuntimeName,
  entry: string,
): Effect.Effect<string, ToolError> =>
  Effect.gen(function* () {
    const path = containedPath(root, entry)
    if (path === undefined) {
      return yield* Effect.fail(
        unavailable('runtime.json points outside ' + root + ' for ' + name + ': ' + entry),
      )
    }
    // A link inside the payload can still resolve outside it, so the check is on
    // what the path really is, not on what the manifest spelled.
    const real = yield* Effect.tryPromise({
      try: () => realpath(path),
      catch: () =>
        unavailable(
          'runtime.json names ' + name + ' at ' + entry + ', but the payload has no such file',
        ),
    })
    if (!real.startsWith(root + sep)) {
      return yield* Effect.fail(
        unavailable('runtime.json points outside ' + root + ' for ' + name + ': ' + entry),
      )
    }
    const info = yield* Effect.tryPromise({
      try: () => stat(real),
      catch: () =>
        unavailable(
          'runtime.json names ' + name + ' at ' + entry + ', but the payload has no such file',
        ),
    })
    if (!info.isFile()) {
      return yield* Effect.fail(
        unavailable('runtime.json names ' + name + ' at ' + entry + ', but it is not a file'),
      )
    }
    // Windows has no execute bit; everywhere else a runtime is something bash can start.
    if (process.platform !== 'win32' && (info.mode & 0o111) === 0) {
      return yield* Effect.fail(
        unavailable('runtime.json names ' + name + ' at ' + entry + ', but it is not executable'),
      )
    }
    return real
  })

/** Reads the payload's manifest; a payload without one is a run without bundled runtimes. */
const readManifest = (root: string): Effect.Effect<WorkspaceDependencyManifest, ToolError> =>
  Effect.gen(function* () {
    const path = join(root, 'runtime.json')
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: (error) =>
        unavailable(
          'no runtime payload at ' + root + ' (looked for ' + path + ': ' + messageOf(error) + ')',
        ),
    })
    const raw = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => unavailable('runtime.json is not valid JSON: ' + path),
    })
    return yield* Schema.decodeUnknownEffect(Manifest)(raw).pipe(
      Effect.mapError(() =>
        unavailable('runtime.json must name python, and may name node and pnpm: ' + path),
      ),
    )
  })

/**
 * Reads the payload this installation is configured with and returns what a
 * command can start from it. Nothing here runs a runtime: the paths are the
 * whole answer, so the model spends its call on the program it wants to run.
 */
export const resolveWorkspaceDependencies = (
  dir: string,
): Effect.Effect<WorkspaceDependenciesValue, ToolError> =>
  Effect.gen(function* () {
    const spelled = expandHome(dir)
    const root = yield* Effect.tryPromise({
      try: () => realpath(spelled),
      catch: (error) =>
        unavailable(
          'no runtime payload at ' +
            spelled +
            ' (the directory is not there: ' +
            messageOf(error) +
            ')',
        ),
    })
    const manifest = yield* readManifest(root)
    const python = yield* runtimePath(root, 'python', manifest.python)
    const node =
      manifest.node === undefined ? undefined : yield* runtimePath(root, 'node', manifest.node)
    const pnpm =
      manifest.pnpm === undefined ? undefined : yield* runtimePath(root, 'pnpm', manifest.pnpm)
    const missing: ReadonlyArray<RuntimeName> = [
      ...(manifest.node === undefined ? (['node'] as const) : []),
      ...(manifest.pnpm === undefined ? (['pnpm'] as const) : []),
    ]
    return {
      root,
      python,
      ...(node === undefined ? {} : { node }),
      ...(pnpm === undefined ? {} : { pnpm }),
      missing,
    }
  })

const Parameters = Schema.Struct({})

export type WorkspaceDependenciesArgs = Schema.Schema.Type<typeof Parameters>

/**
 * Hands the model the paths it needs to run the runtimes this installation ships,
 * instead of whatever the host PATH happens to find. The payload is fixed in the
 * row's config, and every returned path stays inside it.
 */
export const makeWorkspaceDependenciesTool = (
  dir: string,
): ToolDefinition<WorkspaceDependenciesArgs, WorkspaceDependenciesValue> => ({
  name: 'workspace_dependencies',
  description:
    'Returns absolute paths to the Python, Node.js and pnpm this installation ships, so a program can run with the pinned runtime instead of whatever PATH finds. python is always present. node and pnpm appear only when the payload ships them, and every runtime it leaves out is listed in missing. Start the returned path from bash directly. Paths stay inside the payload directory: a payload that names a file outside it is refused with unavailable, and a payload that is not installed says so instead of failing the call silently. This changes neither PATH nor package-manager settings.',
  parameters: Parameters,
  // Reading the payload changes nothing, so two calls may run at the same time.
  isConcurrencySafe: () => true,
  output: {
    schema: Schema.Struct({
      root: Schema.String,
      python: Schema.String,
      node: Schema.optionalKey(Schema.String),
      pnpm: Schema.optionalKey(Schema.String),
      missing: Schema.Array(Schema.Literals(RUNTIMES)),
    }),
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
  },
  execute: () => resolveWorkspaceDependencies(dir),
})

/** The paths the row's payload holds, ready for whoever registers tools into the registry. */
export class WorkspaceDependenciesTools extends Context.Service<
  WorkspaceDependenciesTools,
  ReadonlyArray<ToolDefinition<any, any>>
>()('jozo-harness/WorkspaceDependenciesTools') {}

/** Loader definition for the bundled runtime paths; the row fixes which payload to read. */
export const workspaceDependenciesPlugin: Plugin<
  { readonly dir: string },
  WorkspaceDependenciesTools,
  never
> = {
  name: '@jozo-harness/workspace-dependencies',
  config: Schema.Struct({ dir: Schema.String }),
  provides: [WorkspaceDependenciesTools],
  requires: [],
  layer: (config) =>
    Layer.succeed(WorkspaceDependenciesTools, [makeWorkspaceDependenciesTool(config.dir)]),
}
