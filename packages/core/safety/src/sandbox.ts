import { tmpdir } from 'node:os'
import { Data, Effect, Layer } from 'effect'
import { Context } from 'effect'
import type { SandboxMode } from './policy.ts'

/** The command a tool wants to run, before the sandbox decides how. */
export interface SandboxCommand {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  /** The mode this one command runs under; the provider's standing mode when absent. */
  readonly mode?: SandboxMode
}

/** What a provider hands back: what to spawn, under which mode, and how its denials read. */
export interface ConfinedCommand {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly mode: SandboxMode
  /**
   * The case-insensitive stderr substrings a file effect denied by this provider
   * produces. Empty when nothing confines, so a failure for another reason is
   * never read as a sandbox denial.
   */
  readonly denialSignatures: ReadonlyArray<string>
}

/** A sandbox that cannot wrap a command. Surfaced as a tool error, not a crash. */
export class SandboxError extends Data.TaggedError('SandboxError')<{
  readonly message: string
}> {}

/** How much of a boundary the provider can actually enforce. */
export type SandboxEnforcement = 'full' | 'partial'

export interface SandboxShape {
  readonly name: string
  /**
   * Whether this provider holds commands inside a boundary at all. Without one
   * there is nothing to bound a call to and nothing to escalate beyond.
   */
  readonly confines: boolean
  /**
   * The boundary's reach, for providers whose kernel support is partial. Absent
   * when nothing is confined.
   */
  readonly enforcement?: SandboxEnforcement
  /** The mode commands run under unless one call asks for another. */
  readonly mode: SandboxMode
  /** Returns the command to actually spawn: the original or one wrapped by the provider. */
  readonly wrap: (command: SandboxCommand) => Effect.Effect<ConfinedCommand, SandboxError>
}

export class Sandbox extends Context.Service<Sandbox, SandboxShape>()('jozo-harness/Sandbox') {}

/**
 * The roots a mode lets one command write. The standing roots always count, and
 * workspace-write adds the directory the command runs in and the temp dir, which
 * is what makes a preset mean the same thing to every provider.
 */
export const writableRootsFor = (
  mode: SandboxMode,
  cwd: string,
  standingRoots: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...new Set([...standingRoots, ...(mode === 'workspace-write' ? [cwd, tmpdir()] : [])]),
]

/**
 * Builds what a provider spawns from one command. `wrapArgv` only names the
 * provider's own wrapper; the mode, the roots, and the pass-through for
 * danger-full-access stay here so the providers cannot drift apart.
 */
export const wrapForProvider = (
  command: SandboxCommand,
  standingMode: SandboxMode,
  standingRoots: ReadonlyArray<string>,
  denialSignatures: ReadonlyArray<string>,
  wrapArgv: (mode: SandboxMode, writableRoots: ReadonlyArray<string>) => ReadonlyArray<string>,
): Effect.Effect<ConfinedCommand, SandboxError> => {
  const mode = command.mode ?? standingMode
  if (mode === 'danger-full-access') {
    return Effect.succeed({
      argv: command.argv,
      cwd: command.cwd,
      mode,
      denialSignatures: [],
    })
  }
  return Effect.succeed({
    argv: wrapArgv(mode, writableRootsFor(mode, command.cwd, standingRoots)),
    cwd: command.cwd,
    mode,
    denialSignatures,
  })
}

/** Runs commands unchanged; the default when no sandbox provider is configured. */
export const noneSandbox: SandboxShape = {
  name: 'none',
  confines: false,
  // Nothing is confined, so every command already runs with full access.
  mode: 'danger-full-access',
  wrap: (command) =>
    Effect.succeed({
      argv: command.argv,
      cwd: command.cwd,
      mode: command.mode ?? 'danger-full-access',
      denialSignatures: [],
    }),
}

export const noneSandboxLayer: Layer.Layer<Sandbox, never> = Layer.succeed(Sandbox, noneSandbox)
