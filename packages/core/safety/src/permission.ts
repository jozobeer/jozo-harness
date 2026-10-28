import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type SessionError,
  type SessionEventSchemaMap,
} from '@jozo-harness/session'
import type { SessionEvent } from '@jozo-harness/session'
import { Context, Data, Effect, Schema } from 'effect'
import { modeOf, type PermissionPreset, type SandboxMode } from './policy.ts'
import type { PolicyShape } from './policy-service.ts'
import type { SandboxShape } from './sandbox.ts'

/** One permission change a human made while the session was running. */
export interface PermissionPresetSwitched {
  readonly preset: PermissionPreset
  /** When the human made the choice, not when the process happened to notice it. */
  readonly at: string
}

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'permission/preset': PermissionPresetSwitched
  }
}

/** Schemas for the session event this module adds. */
export const permissionEventSchemas: SessionEventSchemaMap = new Map<
  string,
  Schema.Schema<unknown>
>([
  [
    'permission/preset',
    Schema.Struct({
      preset: Schema.Literals(['read-only', 'workspace-write', 'auto', 'full']),
      at: Schema.String,
    }),
  ],
])

registerSessionEventSchemas(permissionEventSchemas)
// A permission is the human's decision, not a message the model wrote or reads back.
registerLogOnlySessionEvents(['permission/preset'])

/** The preset the session last chose, or nothing when it never switched. */
export const currentPermission = (
  events: ReadonlyArray<SessionEvent>,
): PermissionPreset | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'permission/preset') return event.data.preset
  }
  return undefined
}

/** The boundary words a running session may choose. */
export const PERMISSION_WORDS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One boundary a human can ask for. */
export type PermissionWord = (typeof PERMISSION_WORDS)[number]

/**
 * The preset one boundary word names. `full` is the preset that maps to
 * danger-full-access; the command and the page name the boundary instead, because
 * that is what the human is choosing to change.
 */
export const permissionPresetOf = (word: string): PermissionPreset | undefined => {
  if (word === 'read-only' || word === 'workspace-write') return word
  return word === 'danger-full-access' ? 'full' : undefined
}

/** The boundary a preset runs under, in the words a human chooses from. */
export const permissionWordOf = (preset: PermissionPreset): PermissionWord =>
  preset === 'full' ? 'danger-full-access' : preset === 'auto' ? 'workspace-write' : preset

export const PERMISSION_USAGE = 'usage: /permission <' + PERMISSION_WORDS.join('|') + '>'

/** A switch the log refused to record. */
export class PermissionError extends Data.TaggedError('PermissionError')<{
  readonly code: 'confirmation-required'
  readonly message: string
}> {}

/** What a switcher needs from a session: one event, written before the boundary moves. */
export interface PermissionLog {
  append(
    type: 'permission/preset',
    data: PermissionPresetSwitched,
  ): Effect.Effect<void, SessionError>
}

export interface PermissionSwitchOptions {
  /**
   * Whether a human explicitly asked for this boundary. The page sets it after its
   * confirmation, and a slash command is already the human's own line.
   */
  readonly confirmed: boolean
}

/**
 * Moves the running session to another boundary and leaves the choice in its log.
 * The event goes in first: a failed write must not leave a run wider than the log
 * says it is, because a resumed session would narrow it again.
 */
export const switchPermission = (
  log: PermissionLog,
  permission: PermissionShape,
  preset: PermissionPreset,
  options: PermissionSwitchOptions,
): Effect.Effect<void, SessionError | PermissionError> =>
  Effect.gen(function* () {
    if (preset === 'full' && !options.confirmed) {
      return yield* Effect.fail(
        new PermissionError({
          code: 'confirmation-required',
          message:
            'danger-full-access removes the sandbox; only a human command or a confirmed choice on the page may switch to it',
        }),
      )
    }
    const at = new Date().toISOString()
    yield* log.append('permission/preset', { preset, at })
    permission.apply(preset)
  })

/** The preset and boundary tools read on each call, as the session currently holds them. */
export interface PermissionShape {
  readonly current: () => PermissionPreset
  readonly mode: () => SandboxMode
  /** Applies a preset without recording it; the caller owns the log entry. */
  readonly apply: (preset: PermissionPreset) => void
}

/** The permission a session runs under. It starts from the configured preset. */
export class Permission extends Context.Service<Permission, PermissionShape>()(
  'jozo-harness/Permission',
) {}

/** A holder whose getters follow the latest switch, so no tool captures a stale mode. */
export const makePermission = (initial: PermissionPreset): PermissionShape => {
  let preset = initial
  return {
    current: () => preset,
    mode: () => modeOf(preset),
    apply: (next) => {
      preset = next
    },
  }
}

/** The policy tools see, read through the holder rather than copied at startup. */
export const policyOf = (permission: PermissionShape): PolicyShape => ({
  get preset() {
    return permission.current()
  },
  get mode() {
    return permission.mode()
  },
})

/**
 * A provider that asks the holder for the standing mode on every call. A command
 * that names a mode still wins, and the provider itself is unchanged.
 */
export const sandboxWithPermission = (
  sandbox: SandboxShape,
  permission: PermissionShape,
): SandboxShape => ({
  ...sandbox,
  get mode() {
    return permission.mode()
  },
  wrap: (command) => sandbox.wrap({ ...command, mode: command.mode ?? permission.mode() }),
})
