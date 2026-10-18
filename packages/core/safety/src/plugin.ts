import { PluginError, type Plugin } from '@jozo-harness/kernel'
import { SystemPrompt } from '@jozo-harness/system-prompt'
import { Effect, Layer, Schema } from 'effect'
import { Sandbox, noneSandbox, type SandboxEnforcement, type SandboxShape } from './sandbox.ts'
import { seatbeltSandbox } from './seatbelt.ts'
import { bwrapSandbox, bwrapUnavailableMessage, probeBwrap } from './linux.ts'
import { Ask } from './ask.ts'
import { askServiceLayer } from './ask.ts'
import { Policy, type PolicyShape } from './policy-service.ts'
import { modeOf } from './policy.ts'

export const safetyConfigSchema = Schema.Struct({
  preset: Schema.Literals(['read-only', 'workspace-write', 'full']),
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

const sandboxOf = (
  config: SafetyConfig,
  decision: Extract<SandboxDecision, { _tag: 'available' }>,
): SandboxShape => {
  const mode = modeOf(config.preset)
  const writableRoots = config.writableRoots ?? []
  if (decision.name === 'none') return noneSandbox
  return decision.name === 'seatbelt'
    ? seatbeltSandbox({ mode, writableRoots })
    : bwrapSandbox({ mode, writableRoots })
}

const layerForDecision = (
  config: SafetyConfig,
  decision: SandboxDecision,
): Layer.Layer<Sandbox, PluginError> =>
  decision._tag === 'available'
    ? Layer.succeed(Sandbox, sandboxOf(config, decision))
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
  layerForDecision(config, decideSandbox(config, platform, bwrapUsable))

/**
 * Policy with the runtime facts that name this profile's permissions. The model
 * reads them from the snapshot instead of inferring what a call would be allowed
 * to do. A duplicate fact name is a programming error, not input.
 */
const policyLayerWithContexts = (
  config: SafetyConfig,
  decision: SandboxDecision,
): Layer.Layer<Policy, never, SystemPrompt> =>
  Layer.effect(
    Policy,
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt
      const mode = modeOf(config.preset)
      const confined = decision._tag === 'available' && decision.name !== 'none'
      const backend = decision._tag === 'available' ? decision.name : 'none'
      const enforcement = decision._tag === 'available' ? (decision.enforcement ?? 'full') : 'full'
      yield* prompt.context({
        name: 'approval',
        order: APPROVAL_CONTEXT_ORDER,
        text: () =>
          Effect.succeed(
            'approval: ' +
              config.preset +
              ' (a call this preset refuses is denied; retry it once with sandbox_permissions,' +
              ' which asks the user and is refused at once when nobody can answer)',
          ),
      })
      yield* prompt.context({
        name: 'sandbox',
        order: SANDBOX_CONTEXT_ORDER,
        text: () =>
          Effect.succeed(
            'sandbox: ' +
              (confined ? backend + ' (enforcement: ' + enforcement + ';' : 'none (') +
              (confined
                ? ' commands run confined; a file effect the sandbox refuses comes back as [sandbox: file access denied under ' +
                  mode +
                  ' mode])'
                : 'commands run without a sandbox)'),
          ),
      })
      const shape: PolicyShape = { preset: config.preset, mode }
      return shape
    }).pipe(Effect.orDie),
  )

/** Loader definition for the permission preset and the sandbox provider. */
export const safetyPlugin: Plugin<SafetyConfig, Policy | Sandbox, SystemPrompt> = {
  name: '@jozo-harness/safety',
  config: safetyConfigSchema,
  provides: [Policy, Sandbox],
  requires: [SystemPrompt],
  layer: (config) => {
    const decision = decideSandbox(config, process.platform, probeBwrap)
    return Layer.mergeAll(
      policyLayerWithContexts(config, decision),
      layerForDecision(config, decision),
    )
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
