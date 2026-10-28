import { Hooks, type Plugin } from '@jozo-harness/kernel'
import { Sandbox } from '@jozo-harness/safety'
import { Context, Effect, Layer, Schema } from 'effect'
import { installHooksJson, type HooksJsonOptions } from './bridge.ts'

/** The name a workspace's foreign hook file usually has. */
export const DEFAULT_HOOKS_PATH = 'hooks.json'

/** The reference formats' default deadline for one command. */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000

const hooksJsonConfigSchema = Schema.Struct({
  /** A hooks.json path; a relative one resolves against each call's cwd. */
  path: Schema.optionalKey(Schema.String),
  /** The deadline for a command that sets none, in milliseconds. */
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type HooksJsonConfig = Schema.Schema.Type<typeof hooksJsonConfigSchema>

/** Where this run reads hooks and how long it lets one command take. */
export class HooksJson extends Context.Service<HooksJson, HooksJsonOptions>()(
  'jozo-harness/HooksJson',
) {}

/**
 * Runs the Claude Code and Codex command-hook subset at the tool pipeline.
 * Tool names are matched case-insensitively, so a config written for Claude
 * Code's `Bash` also reaches jzh's `bash`. A workspace without hooks.json gets
 * the same calls and results as one without this plugin: the listeners only
 * read a file and delegate.
 */
export const hooksJsonPlugin: Plugin<HooksJsonConfig, HooksJson, Hooks | Sandbox> = {
  name: '@jozo-harness/hooks-json',
  config: hooksJsonConfigSchema,
  provides: [HooksJson],
  requires: [Hooks, Sandbox],
  layer: (config) => {
    const options: HooksJsonOptions = {
      path: config.path ?? DEFAULT_HOOKS_PATH,
      timeoutMs: config.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    }
    return Layer.effect(
      HooksJson,
      Effect.gen(function* () {
        const hooks = yield* Hooks
        const sandbox = yield* Sandbox
        yield* installHooksJson(hooks, sandbox, options)
        return options
      }),
    )
  },
}
