import { Effect, type Scope } from 'effect'
import { isAbsolute, join } from 'node:path'
import type { HookRegistry } from '@jozo-harness/kernel'
import type { SandboxShape } from '@jozo-harness/safety'
import {
  errorResult,
  toolErrorInfo,
  type PreExecuteDecision,
  type ToolExecution,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { matchesTool, readHooksFile, type HookCommand, type HookEvent } from './config.ts'
import { hookPayload, runHookCommand } from './run.ts'

/** Where the bridge looks and how long one command may take. */
export interface HooksJsonOptions {
  /** The hooks.json path; a relative one resolves against each call's cwd. */
  readonly path: string
  /** The deadline for a command whose group sets none. */
  readonly timeoutMs: number
}

/** The absolute hooks.json path for this call. */
export const hooksFileAt = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : join(cwd, path)

interface ResolvedHooks {
  readonly commands: ReadonlyArray<HookCommand>
  /** Why the file could not be used, when it exists but cannot be parsed. */
  readonly warning?: string
}

const resolveHooks = (
  options: HooksJsonOptions,
  exec: ToolExecution,
  event: HookEvent,
): Effect.Effect<ResolvedHooks> =>
  Effect.map(readHooksFile(hooksFileAt(exec.context.cwd, options.path)), (file) => {
    if (file.kind === 'ok') {
      return {
        commands: file.commands.filter(
          (hook) => hook.event === event && matchesTool(hook.matcher, exec.tool),
        ),
      }
    }
    if (file.kind === 'invalid') {
      return {
        commands: [],
        warning: file.reason + '; the call ran without foreign hooks',
      }
    }
    return { commands: [] }
  })

const announce = (exec: ToolExecution, warning: string | undefined): Effect.Effect<void> =>
  warning === undefined || exec.context.addContext === undefined
    ? Effect.void
    : Effect.sync(() => exec.context.addContext?.(warning))

const firstDenial = (
  sandbox: SandboxShape,
  commands: ReadonlyArray<HookCommand>,
  payload: Readonly<Record<string, unknown>>,
  cwd: string,
  options: HooksJsonOptions,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    for (const hook of commands) {
      const outcome = yield* runHookCommand(sandbox, hook, payload, cwd, options.timeoutMs)
      if (outcome.kind === 'deny') return outcome.reason
    }
    return undefined
  })

const beforeTool = (
  sandbox: SandboxShape,
  options: HooksJsonOptions,
  exec: ToolExecution,
  next: () => Effect.Effect<PreExecuteDecision>,
): Effect.Effect<PreExecuteDecision> =>
  Effect.gen(function* () {
    const resolved = yield* resolveHooks(options, exec, 'PreToolUse')
    yield* announce(exec, resolved.warning)
    const denial = yield* firstDenial(
      sandbox,
      resolved.commands,
      hookPayload('PreToolUse', exec),
      exec.context.cwd,
      options,
    )
    if (denial !== undefined) return { kind: 'deny', reason: denial }
    return (yield* next()) ?? { kind: 'allow' }
  })

const afterTool = (
  sandbox: SandboxShape,
  options: HooksJsonOptions,
  exec: ToolExecution,
  result: ToolExecutionResult,
  next: () => Effect.Effect<ToolExecutionResult>,
): Effect.Effect<ToolExecutionResult> =>
  Effect.gen(function* () {
    const posted = (yield* next()) ?? result
    const resolved = yield* resolveHooks(options, exec, 'PostToolUse')
    yield* announce(exec, resolved.warning)
    const denial = yield* firstDenial(
      sandbox,
      resolved.commands,
      hookPayload('PostToolUse', exec, posted),
      exec.context.cwd,
      options,
    )
    if (denial === undefined) return posted
    return errorResult('denied by PostToolUse hook: ' + denial, toolErrorInfo('denied', denial))
  })

/**
 * Registers the hooks.json bridge at the two tool points. The listeners live in
 * the caller's scope, so a session that closes stops running hooks with it.
 */
export const installHooksJson = (
  hooks: HookRegistry,
  sandbox: SandboxShape,
  options: HooksJsonOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* hooks.on('tools/pre-execute', (exec, next) => beforeTool(sandbox, options, exec, next))
    yield* hooks.on('tools/post-execute', (exec, result, next) =>
      afterTool(sandbox, options, exec, result, next),
    )
  })
