import { loadBundledProfile, loadBundledProfileNamed } from '@jozo-harness/bundle-base'
import { type PluginRow } from '@jozo-harness/kernel'
import { cwdOf, titleOf, type SessionEvent, type SessionHeader } from '@jozo-harness/session'
import { jsonlSessions, makeSessionQuery } from '@jozo-harness/session-jsonl'
import type { TuiIo } from '@jozo-harness/tui'
import { Effect, Stream } from 'effect'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type SearchHost } from '@jozo-harness/tools-tier1'
import { parseArgs, type ParsedArgs } from './args.ts'
import { configPaths, loadSecrets } from './config.ts'
import { loadConfigFile, type JozoHarnessConfig } from './config-file.ts'
import { loadEnvFrom } from './env-file.ts'
import { resolveSettings, type SettingsSurface } from './settings.ts'
import { listModels, modelEndpointOf } from './models.ts'
import { bundledPlugins } from './plugins.ts'
import { searchFromEnv } from './search-env.ts'
import {
  renderSearchHits,
  renderSessionHead,
  renderSessionList,
  renderTranscript,
  sessionRootOf,
} from './session-list.ts'
import { profileRows, runCommand, type CommandOptions } from './index.ts'

export interface MainIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly cwd: string
  /** Batch input; the real entry point streams process.stdin when it is not a terminal. */
  readonly lines?: Stream.Stream<string>
  /** The terminal UI; the real entry point builds one when stdin is a terminal. */
  readonly tui?: TuiIo
  /** True when the caller sits on a terminal. */
  readonly tty?: boolean
  /** Completes to request a user cancellation of the running turn. */
  readonly interrupt?: Effect.Effect<void>
}

const HELP = `jzh "task"                     one-shot headless run
jzh                             terminal UI (a terminal is required)
jzh --profile <name> --patch <file.yml>...
jzh --config <file.yml>        settings (default: ~/.config/jzh/config.yaml)
jzh --model <provider/model>    the route to use (jzh models lists them)
jzh --effort <level>           the reasoning effort to ask the provider for
jzh --dump-config
jzh config [set K V|init]       settings: show them, write one key, start a file
jzh models                      list the models the provider offers
jzh auth [add|set|list|remove]  keep the keys a provider needs
jzh web [--port N] [--public-url <https origin>]
                                browser UI over a local server
jzh --resume <sessionId> [task]
jzh sessions                    list the sessions on disk
jzh sessions <sessionId>        read one session back
jzh sessions --search <text>    find sessions by what they say
jzh sessions --all              list the sessions nobody said anything in too
jzh --allow-preset-change         continue a session that lost a tool or changed profile
jzh --subagents                  let the model run and steer child agents
jzh --json "task"
jzh --tui                       terminal UI even through a pipe
`

/** Everything the command reads from the environment and files before running. */
interface CommandInputs {
  readonly settings: JozoHarnessConfig
  /** The file the settings came from, so `--dump-config` can name it. */
  readonly settingsPath: string
  /** What is in effect and which file filled each credential. */
  readonly surface: SettingsSurface
  readonly route: string
  /** The effort resolved from --effort and the settings file; '' means a row, or the provider. */
  readonly effort: string
  readonly documents: ReadonlyArray<string>
  readonly patches: ReadonlyArray<string>
  readonly search: SearchHost | undefined
}

const readText = (
  read: () => Promise<string>,
  describe: (cause: unknown) => string,
): Effect.Effect<string, Error> =>
  Effect.tryPromise({ try: read, catch: (cause) => new Error(describe(cause)) })

const loadInputs = (parsed: ParsedArgs, io: MainIo): Effect.Effect<CommandInputs, Error> =>
  Effect.gen(function* () {
    // The nearest .env fills what the environment does not define; the
    // secrets file is separate so it can stay unreadable.
    const fromDotenv = loadEnvFrom(io.cwd)
    const fromSecrets = loadSecrets(configPaths().secrets, process.env, io.stderr)
    const settingsPath = parsed.config ?? configPaths().config
    const settings = yield* loadConfigFile(settingsPath)
    // One resolver answers what is in effect, for the run and for --dump-config.
    const effective = resolveSettings({
      flags: {
        profile: parsed.profileFlag,
        model: parsed.modelFlag,
        effort: parsed.effortFlag,
        port: parsed.portFlag,
      },
      settings,
      settingsPath,
      fallbackProfile: parsed.profile,
      fallbackRoute: parsed.model,
      fallbackEffort: parsed.effort,
    })
    const profileName = effective.profile.value
    const route = effective.route.value
    const effort = effective.effort.value
    const base = yield* readText(
      loadBundledProfile,
      (cause) => `cannot read the bundled profile: ${String(cause)}`,
    )
    const named = yield* readText(
      () => loadBundledProfileNamed(profileName),
      (cause) => `cannot read profile ${profileName}: ${String(cause)}`,
    )
    const patches = yield* Effect.forEach(parsed.patches, (path) =>
      readText(
        () => readFile(path, 'utf8'),
        (cause) => `cannot read patch ${path}: ${String(cause)}`,
      ),
    )
    return {
      settings,
      settingsPath,
      surface: { effective, filled: { fromDotenv, fromSecrets } },
      route,
      effort,
      documents: [base, named],
      patches,
      search: searchFromEnv(process.env, settings),
    }
  })

/** `jzh sessions [id]`: the sessions on disk, or one read back as a transcript. */
/** The header a log opens with, once it has been read back. The reader guarantees one. */
const headerOf = (events: ReadonlyArray<SessionEvent>): SessionHeader | undefined => {
  const first = events[0]
  return first?.type === 'session/header' ? first.data : undefined
}

/** When the log last changed: the newest event's time, or the moment it was born. */
const updatedAtOf = (events: ReadonlyArray<SessionEvent>, createdAt: number): number =>
  events[events.length - 1]?.time ?? createdAt

const printSessions = (
  inputs: CommandInputs,
  io: MainIo,
  id: string | undefined,
  search: string | undefined,
  all: boolean,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const rows = yield* profileRows({
      profiles: inputs.documents,
      patches: inputs.patches,
      ...optional('extraRows', inputs.settings.plugins),
    })
    const root = sessionRootOf(rows)
    const sessions = jsonlSessions({ root })
    if (search !== undefined) {
      if (id !== undefined) {
        io.stderr('jzh: sessions --search looks through every session; drop the id')
        return 1
      }
      const query = makeSessionQuery({ root, sessions })
      const hits = yield* query.search(search)
      query.close()
      io.stdout(renderSearchHits(hits))
      return 0
    }
    if (id === undefined) {
      io.stdout(renderSessionList(yield* sessions.list(), { showEmpty: all }))
      return 0
    }
    // The browse reads through the query's observation, so the cut it shows is
    // the same shared, disposable one a search sync would have worked from.
    const query = makeSessionQuery({ root, sessions })
    const observed = yield* query.observe(id)
    const header = headerOf(observed.events)
    io.stdout(
      renderSessionHead({
        id: observed.id,
        cwd: header === undefined ? '' : cwdOf(observed.events, header),
        createdAt: header?.createdAt ?? 0,
        updatedAt: updatedAtOf(observed.events, header?.createdAt ?? 0),
        title: titleOf(observed.events),
      }) + renderTranscript(observed.events),
    )
    observed.dispose()
    return 0
  }).pipe(
    Effect.match({
      onFailure: (error: unknown) => {
        io.stderr('jzh: ' + String(error) + String.fromCharCode(10))
        return 1
      },
      onSuccess: (code) => code,
    }),
  )

/** Every model the profile's provider offers, as sorted routes. */
const routesOf = (rows: ReadonlyArray<PluginRow>): Effect.Effect<ReadonlyArray<string>, Error> => {
  const endpoint = modelEndpointOf(rows)
  return endpoint === undefined
    ? Effect.fail(new Error('the profile has no @jozo-harness/llm-openai row to ask for models'))
    : listModels(endpoint, process.env)
}

type Present<K extends keyof CommandOptions> = Pick<CommandOptions, K>

/** A field is left out entirely when its value is missing; exactOptionalPropertyTypes. */
const optional = <K extends keyof CommandOptions>(
  key: K,
  value: CommandOptions[K] | undefined,
): Present<K> | Record<never, never> =>
  value === undefined ? {} : ({ [key]: value } as Present<K>)

const workSelection = (
  parsed: ParsedArgs,
  io: MainIo,
  port: number,
): Present<'task'> | Present<'tui'> | Present<'web'> | Present<'lines'> | Record<never, never> => {
  if (parsed.task !== undefined) return { task: parsed.task }
  if (parsed.web) return { web: { port, publicUrl: parsed.publicUrl } }
  const tui = io.tui
  if (tui !== undefined && !parsed.json && (parsed.tui || io.tty === true)) return { tui }
  return io.lines === undefined ? {} : { lines: io.lines }
}

const commandOptions = (parsed: ParsedArgs, io: MainIo, inputs: CommandInputs): CommandOptions => ({
  profiles: inputs.documents,
  plugins: bundledPlugins,
  cwd: io.cwd,
  route: inputs.route,
  effort: inputs.effort,
  // The jzh home: where the sessions root lives, so user-global instructions sit there too.
  jzhHome: join(homedir(), '.jzh'),
  settingsPath: inputs.settingsPath,
  settings: inputs.settings,
  stdout: io.stdout,
  stderr: io.stderr,
  ...optional('extraRows', inputs.settings.plugins),
  ...optional('skills', inputs.settings.skills),
  ...optional('search', inputs.search),
  // The port is resolved from --port and the settings file before a web run serves.
  ...workSelection(parsed, io, inputs.surface.effective.port.value),
  ...optional('resume', parsed.resume),
  ...(parsed.allowPresetChange ? { allowPresetChange: true } : {}),
  ...(parsed.subagents ? { subagents: true } : {}),
  ...(inputs.patches.length === 0 ? {} : { patches: inputs.patches }),
  surface: inputs.surface,
  ...(parsed.dumpConfig ? { dumpConfig: true } : {}),
  ...(parsed.json ? { json: true } : {}),
  ...optional('interrupt', io.interrupt),
})

/** `jzh models`: one route per line on stdout; a failure is one line on stderr. */
const printModels = (inputs: CommandInputs, io: MainIo): Effect.Effect<number> =>
  profileRows({
    profiles: inputs.documents,
    patches: inputs.patches,
    ...optional('extraRows', inputs.settings.plugins),
  }).pipe(
    Effect.flatMap(routesOf),
    Effect.match({
      onFailure: (error) => {
        io.stderr(`jzh: ${error.message}\n`)
        return 1
      },
      onSuccess: (routes) => {
        io.stdout(routes.map((route) => route + '\n').join(''))
        return 0
      },
    }),
  )

/** The `jzh` entry point: parse argv, load the bundled base profile, run. */
export function main(argv: ReadonlyArray<string>, io: MainIo): Effect.Effect<number> {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    io.stdout(HELP)
    return Effect.succeed(0)
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) io.stderr(`jzh: ${error}\n`)
    return Effect.succeed(2)
  }
  return Effect.gen(function* () {
    const inputs = yield* loadInputs(parsed, io)
    if (parsed.models) return yield* printModels(inputs, io)
    if (parsed.sessions) {
      return yield* printSessions(inputs, io, parsed.sessionId, parsed.search, parsed.all)
    }
    return yield* runCommand(commandOptions(parsed, io, inputs))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        io.stderr(`jzh: ${String(cause)}\n`)
        return 1
      }),
    ),
  )
}
