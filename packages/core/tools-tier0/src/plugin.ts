import { PluginError, type Plugin } from '@jozo-harness/kernel'
import { Sandbox, sshSandbox, type ApprovalShape, type SandboxShape } from '@jozo-harness/safety'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import type { ToolDefinition } from '@jozo-harness/tools'
import type { FileSystemShape } from '@jozo-harness/filesystem'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'
import { probeSshBwrap, sshFileSystem, type SshHostOptions } from '@jozo-harness/filesystem'
import { BASH_MAX_TIMEOUT_MS, type TimeoutJobs } from './bash.ts'
import { managedEnv } from './managed-env.ts'
import type { ShellSessions } from './shells.ts'
import type { WorktreeHost } from './worktree.ts'
import { tier0Tools } from './index.ts'

/**
 * Builds the Tier 0 tool list: the profile's sandbox, and the approval seam of
 * this run. The seam is the caller's, not the profile's — a deployment that
 * composes no answerer passes nothing and every escalation is refused.
 */
export type Tier0ToolBuilder = (
  approval: ApprovalShape | undefined,
  jobs?: TimeoutJobs,
  worktree?: WorktreeHost,
  /** The shells a named bash session keeps; the run closes them when it ends. */
  sessions?: ShellSessions,
  /** The wait a bash call gets when it names none; overrides the row's timeoutMs. */
  defaultTimeoutMs?: () => number | undefined,
) => ReadonlyArray<ToolDefinition<any, any>>

/** The Tier 0 tool list, ready for whoever registers tools into the registry. */
export class Tier0Tools extends Context.Service<Tier0Tools, Tier0ToolBuilder>()(
  'jozo-harness/Tier0Tools',
) {}

/** A host a profile names instead of this machine; every tool then reads and runs there. */
const sshConfigSchema = Schema.Struct({
  /** The ssh destination and flags, e.g. `["ssh", "-p", "2222", "host"]`. */
  reach: Schema.Array(Schema.String),
  /** The workspace on the host; a tool path is read against it. */
  root: Schema.String,
  /** The mode commands run under. Defaults to workspace-write. */
  mode: Schema.optionalKey(Schema.Literals(['read-only', 'workspace-write', 'danger-full-access'])),
})

/** The harness-owned variables a profile registers for every command. */
const tier0ConfigSchema = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The wait a bash call gets when it names none, in milliseconds. Defaults to 120000. */
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BASH_MAX_TIMEOUT_MS })),
  ),
  /**
   * Work on a host over ssh instead of this machine. Absent keeps every tool on
   * the local disk, so a profile that never names a host behaves as before.
   */
  ssh: Schema.optionalKey(sshConfigSchema),
})

export type Tier0Config = Schema.Schema.Type<typeof tier0ConfigSchema>

/** The seams a run reads and runs through, whichever machine they are on. */
export interface Tier0Seams {
  readonly fileSystem: FileSystemShape
  readonly sandbox: SandboxShape
}

/** Why a host the run cannot use is refused, in a person's words. */
export const sshUnusableMessage = (root: string, reason: string): string =>
  'the ssh host ' + root + ' cannot be used: ' + reason

/** The host options a profile named, before the probe answers. */
export const hostOptionsOf = (config: Tier0Config): SshHostOptions | undefined =>
  config.ssh === undefined
    ? undefined
    : {
        reach: config.ssh.reach,
        root: config.ssh.root,
        ...(config.ssh.mode === undefined ? {} : { mode: config.ssh.mode }),
        confines: false,
      }

/**
 * The seams for the profile's host. A host without bwrap fails the row instead
 * of running commands unconfined: workspace-write there would be a promise
 * nothing keeps, which is worse than refusing to start.
 */
export const seamsOf = (
  config: Tier0Config,
  localSandbox: SandboxShape,
  probe: (options: SshHostOptions) => Promise<boolean>,
): Effect.Effect<Tier0Seams, PluginError> => {
  const options = hostOptionsOf(config)
  if (options === undefined) {
    return Effect.succeed({ fileSystem: nodeFileSystem, sandbox: localSandbox })
  }
  return Effect.gen(function* () {
    const confines = yield* Effect.promise(() => probe(options))
    if (!confines) {
      return yield* Effect.fail(
        new PluginError({
          code: 'unavailable',
          message: sshUnusableMessage(options.root, 'its bwrap cannot hold a command'),
        }),
      )
    }
    const host = { ...options, confines }
    return {
      fileSystem: sshFileSystem(host),
      sandbox: sshSandbox({
        reach: host.reach,
        root: host.root,
        confines,
        ...(host.mode === undefined ? {} : { mode: host.mode }),
      }),
    }
  })
}

/** Loader definition for the Tier 0 tools; bash uses the profile's sandbox and env. */
export const tier0Plugin: Plugin<
  Schema.Schema.Type<typeof tier0ConfigSchema>,
  Tier0Tools,
  Sandbox
> = {
  name: '@jozo-harness/tools-tier0',
  config: tier0ConfigSchema,
  provides: [Tier0Tools],
  requires: [Sandbox],
  layer: (config) =>
    Layer.effect(
      Tier0Tools,
      Effect.gen(function* () {
        const localSandbox = yield* Sandbox
        const managed = yield* Effect.try({
          try: () => managedEnv(config.env ?? {}),
          catch: (error) =>
            new PluginError({
              code: 'config',
              message: error instanceof Error ? error.message : String(error),
            }),
        })
        const seams = yield* seamsOf(config, localSandbox, probeSshBwrap)
        return (approval, jobs, worktree, sessions, defaultTimeoutMs) =>
          tier0Tools(
            seams.fileSystem,
            seams.sandbox,
            undefined,
            approval,
            jobs,
            // A worktree is a local git operation; a host's workspace is not
            // this machine's checkout, so the tool is not offered there.
            config.ssh === undefined ? worktree : undefined,
            sessions,
            managed,
            defaultTimeoutMs ?? (() => config.timeoutMs),
          )
      }),
    ),
}

/**
 * The workspace a run works in when the profile names a host: the host's root,
 * not this machine's directory. A run still starts in its own cwd when no host
 * is named, which is every profile that does not carry an `ssh` row.
 */
export const workspaceOf = (
  rows: ReadonlyArray<{ readonly name: string; readonly config?: unknown }>,
): string | undefined => {
  const row = rows.find((each) => each.name === '@jozo-harness/tools-tier0')
  if (row === undefined) return undefined
  const parsed = Schema.decodeUnknownOption(tier0ConfigSchema)(row.config ?? {})
  return Option.isSome(parsed) ? parsed.value.ssh?.root : undefined
}
