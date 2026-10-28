import { PluginError, type Plugin } from '@jozo-harness/kernel'
import { SystemPrompt } from '@jozo-harness/system-prompt'
import { Effect, Layer, Schema } from 'effect'
import { Sandbox, noneSandbox, type SandboxEnforcement, type SandboxShape } from './sandbox.ts'
import {
  probeSeatbelt,
  seatbeltSandbox,
  seatbeltWarning,
  type SeatbeltProbeResult,
} from './seatbelt.ts'
import { bwrapSandbox, bwrapUnavailableMessage, probeBwrap } from './linux.ts'
import { Ask } from './ask.ts'
import { askServiceLayer } from './ask.ts'
import { Policy, type PolicyShape } from './policy-service.ts'
import { modeOf, type SandboxMode } from './policy.ts'
import { AutoReview, autoReviewServiceLayer } from './auto-review.ts'
import {
  Permission,
  permissionLayer,
  policyOf,
  sandboxWithPermission,
  type PermissionShape,
} from './permission.ts'

export const safetyConfigSchema = Schema.Struct({
  preset: Schema.Literals(['read-only', 'workspace-write', 'auto', 'full']),
  sandbox: Schema.optionalKey(Schema.Literals(['none', 'seatbelt', 'bwrap', 'auto'])),
  /** Roots the sandboxed process may write; empty means deny all writes. */
  writableRoots: Schema.optionalKey(Schema.Array(Schema.String)),
})

export type SafetyConfig = Schema.Schema.Type<typeof safetyConfigSchema>

/** The permissions sort after the workspace the loop owns and before the clock. */
const APPROVAL_CONTEXT_ORDER = 20
const SANDBOX_CONTEXT_ORDER = 21

/** What the profile asked for; `auto` means the backend this platform has. */
export type SandboxSetting = 'none' | 'seatbelt' | 'bwrap' | 'auto'

/** The backend the profile gets, or why there is none. */
export type SandboxDecision =
  | {
      readonly _tag: 'available'
      readonly name: 'none' | 'seatbelt' | 'bwrap'
      readonly enforcement?: SandboxEnforcement
    }
  | { readonly _tag: 'unavailable'; readonly message: string }

const unavailablePlatformMessage = (platform: string): string =>
  'no sandbox backend runs on ' + platform + '; pass sandbox: none to run commands without one.'

const backendUnavailableMessage = (backend: string, platform: string): string =>
  'the ' +
  backend +
  ' sandbox runs on ' +
  (backend === 'seatbelt' ? 'macOS' : 'Linux') +
  ' only; this is ' +
  platform +
  '. Pass sandbox: none to run commands without one.'

const nativeBackend = (platform: string): 'seatbelt' | 'bwrap' | undefined => {
  if (platform === 'darwin') return 'seatbelt'
  if (platform === 'linux') return 'bwrap'
  return undefined
}

const seatbeltDecision = (platform: string): SandboxDecision =>
  platform === 'darwin'
    ? { _tag: 'available', name: 'seatbelt', enforcement: 'full' }
    : { _tag: 'unavailable', message: backendUnavailableMessage('seatbelt', platform) }

const bwrapDecision = (platform: string, bwrapUsable: () => boolean): SandboxDecision => {
  if (platform !== 'linux') {
    return { _tag: 'unavailable', message: backendUnavailableMessage('bwrap', platform) }
  }
  return bwrapUsable()
    ? { _tag: 'available', name: 'bwrap', enforcement: 'full' }
    : { _tag: 'unavailable', message: bwrapUnavailableMessage(platform) }
}

/**
 * The backend a profile actually gets. `auto` (the default) takes the native
 * one, and an explicit name that this platform cannot run fails rather than
 * quietly running unrestricted. On Linux, bwrap has to pass its probe because an
 * installed bwrap that cannot create namespaces would fail every command.
 */
export const decideSandbox = (
  config: SafetyConfig,
  platform: string,
  bwrapUsable: () => boolean,
): SandboxDecision => {
  const setting = config.sandbox ?? 'auto'
  const backend = setting === 'auto' ? nativeBackend(platform) : setting
  if (backend === undefined) {
    return { _tag: 'unavailable', message: unavailablePlatformMessage(platform) }
  }
  if (backend === 'none') return { _tag: 'available', name: 'none' }
  return backend === 'seatbelt' ? seatbeltDecision(platform) : bwrapDecision(platform, bwrapUsable)
}

/**
 * The startup line for a profile that would run under the seatbelt. The probe runs
 * only when that is the backend this platform would apply and the preset keeps
 * commands confined; the decision, and so the default behavior, is unchanged.
 */
export const seatbeltStartupNotice = (
  config: SafetyConfig,
  platform: string,
  probe: () => SeatbeltProbeResult = probeSeatbelt,
): string | undefined => {
  // bwrap is irrelevant here: the only answer this needs is whether the seatbelt runs.
  const decision = decideSandbox(config, platform, () => false)
  return underSeatbelt(config, decision) ? seatbeltWarning(probe()) : undefined
}

/**
 * Whether commands would actually be wrapped by the seatbelt. Only then does the
 * probe's answer matter: the full preset hands commands straight to the shell.
 */
const underSeatbelt = (config: SafetyConfig, decision: SandboxDecision): boolean =>
  decision._tag === 'available' &&
  decision.name === 'seatbelt' &&
  modeOf(config.preset) !== 'danger-full-access'

const REFUSED_SEATBELT = '; the seatbelt cannot be applied here, so commands are refused'

/**
 * The sandbox line the runtime context shows. A refused seatbelt cannot wrap a
 * command, so the line ends with that reason instead of letting the model read
 * the refusal as a file denial; an applied or missing binary keeps the wording
 * it had, and no other backend changes.
 */
export const sandboxContextText = (
  config: SafetyConfig,
  decision: SandboxDecision,
  probe: SeatbeltProbeResult | undefined,
  mode: SandboxMode = modeOf(config.preset),
): string => {
  const confined = decision._tag === 'available' && decision.name !== 'none'
  const backend = decision._tag === 'available' ? decision.name : 'none'
  const enforcement = decision._tag === 'available' ? (decision.enforcement ?? 'full') : 'full'
  const refused =
    probe === 'refused' &&
    decision._tag === 'available' &&
    decision.name === 'seatbelt' &&
    mode !== 'danger-full-access'
  const line = confined
    ? 'sandbox: ' +
      mode +
      ' (backend: ' +
      backend +
      '; enforcement: ' +
      enforcement +
      '; commands run confined; a file effect the sandbox refuses comes back as [sandbox: file access denied under ' +
      mode +
      ' mode])'
    : 'sandbox: none (commands run without a sandbox)'
  return refused ? line + REFUSED_SEATBELT : line
}

const sandboxOf = (
  config: SafetyConfig,
  decision: Extract<SandboxDecision, { _tag: 'available' }>,
  permission: PermissionShape,
): SandboxShape => {
  const writableRoots = config.writableRoots ?? []
  // A run without a backend is unconfined whatever the preset says, so its mode
  // stays full access; there is no boundary for a switch to widen or narrow.
  if (decision.name === 'none') return noneSandbox
  const provider =
    decision.name === 'seatbelt'
      ? seatbeltSandbox({ mode: permission.mode(), writableRoots })
      : bwrapSandbox({ mode: permission.mode(), writableRoots })
  return sandboxWithPermission(provider, permission)
}

const layerForDecision = (
  config: SafetyConfig,
  decision: SandboxDecision,
): Layer.Layer<Sandbox, PluginError, Permission> =>
  decision._tag === 'available'
    ? Layer.effect(
        Sandbox,
        Effect.map(Permission, (permission) => sandboxOf(config, decision, permission)),
      )
    : Layer.effect(
        Sandbox,
        Effect.fail(new PluginError({ code: 'unavailable', message: decision.message })),
      )

/**
 * The sandbox this platform can actually run. Commands run contained unless the
 * profile says `sandbox: none`, and a platform without a usable backend fails the
 * loader instead of quietly running unrestricted. The network stays open because
 * the permission policy, not the sandbox, is what decides whether a call may
 * reach out; the sandbox contains the filesystem.
 */
export const sandboxLayerFor = (
  config: SafetyConfig,
  platform: string,
  bwrapUsable: () => boolean = probeBwrap,
): Layer.Layer<Sandbox, PluginError> =>
  layerForDecision(config, decideSandbox(config, platform, bwrapUsable)).pipe(
    Layer.provide(permissionLayer(config.preset)),
  )

/**
 * Policy with the runtime facts that name this profile's permissions. The model
 * reads them from the snapshot instead of inferring what a call would be allowed
 * to do. A duplicate fact name is a programming error, not input.
 */
const policyLayerWithContexts = (
  config: SafetyConfig,
  decision: SandboxDecision,
  probe: SeatbeltProbeResult | undefined,
): Layer.Layer<Policy, never, SystemPrompt | Permission> =>
  Layer.effect(
    Policy,
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt
      const permission = yield* Permission
      yield* prompt.context({
        name: 'approval',
        order: APPROVAL_CONTEXT_ORDER,
        text: () =>
          Effect.succeed(
            'approval: ' +
              permission.current() +
              ' (a call this preset refuses is denied; retry it once with sandbox_permissions,' +
              ' which asks the user and is refused at once when nobody can answer)',
          ),
      })
      yield* prompt.context({
        name: 'sandbox',
        order: SANDBOX_CONTEXT_ORDER,
        text: () => Effect.succeed(sandboxContextText(config, decision, probe, permission.mode())),
      })
      const shape: PolicyShape = policyOf(permission)
      return shape
    }).pipe(Effect.orDie),
  )

/**
 * Loader definition for the permission preset, the sandbox provider, and the
 * review seam. The seam is provided for every preset because the preset decides
 * who asks it; the auto preset installs the guard that does.
 */
export const safetyPlugin: Plugin<
  SafetyConfig,
  Policy | Sandbox | AutoReview | Permission,
  SystemPrompt
> = {
  name: '@jozo-harness/safety',
  config: safetyConfigSchema,
  provides: [Policy, Sandbox, AutoReview, Permission],
  requires: [SystemPrompt],
  layer: (config) => {
    const decision = decideSandbox(config, process.platform, probeBwrap)
    // One probe per build: every runtime context and every wrapped command share it.
    const probe = underSeatbelt(config, decision) ? probeSeatbelt() : undefined
    // The holder is an effect, not a captured value: building the same layer for a
    // second session gives that session its own boundary.
    const services = Layer.mergeAll(
      policyLayerWithContexts(config, decision, probe),
      layerForDecision(config, decision),
      autoReviewServiceLayer,
    )
    return services.pipe(Layer.provideMerge(permissionLayer(config.preset)))
  },
}

/** Loader definition for the ask holder: questions wait for an answer. */
export const askPlugin: Plugin<{}, Ask, never> = {
  name: '@jozo-harness/ask',
  config: Schema.Struct({}),
  provides: [Ask],
  requires: [],
  layer: () => askServiceLayer,
}
