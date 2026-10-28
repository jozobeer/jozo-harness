import { Effect } from 'effect'
import { spawn } from '@jozo-harness/process'
import type { SandboxShape } from '@jozo-harness/safety'
import type { ToolExecution, ToolExecutionResult } from '@jozo-harness/tools'
import type { HookCommand, HookEvent } from './config.ts'

/** A hook command's answer, as the bridge reads it. */
export type HookOutcome =
  | { readonly kind: 'pass'; readonly stdout: string; readonly stderr: string }
  | {
      readonly kind: 'deny'
      readonly reason: string
      readonly stdout: string
      readonly stderr: string
    }

/** What one command wrote and how it exited, before its answer is decoded. */
export interface HookProcess {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsedObject = (stdout: string): Record<string, unknown> | undefined => {
  const text = stdout.trim()
  if (!text.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

const fallbackReason = (event: HookEvent): string => 'denied by ' + event + ' hook'

const topLevelDenial = (answer: Record<string, unknown>, event: HookEvent): string | undefined => {
  const decision = stringField(answer, 'decision')
  if (decision !== 'deny' && decision !== 'block') return undefined
  return stringField(answer, 'reason') ?? fallbackReason(event)
}

const specificDenial = (answer: Record<string, unknown>, event: HookEvent): string | undefined => {
  const specific = answer['hookSpecificOutput']
  if (!isRecord(specific)) return undefined
  if (specific['hookEventName'] !== event) return undefined
  const permission = stringField(specific, 'permissionDecision')
  if (permission !== 'deny' && permission !== 'block') return undefined
  return stringField(specific, 'permissionDecisionReason') ?? fallbackReason(event)
}

/** The reason a structured answer gave, if it asked to deny the call. */
const structuredDenial = (answer: Record<string, unknown>, event: HookEvent): string | undefined =>
  topLevelDenial(answer, event) ?? specificDenial(answer, event)

/**
 * Decodes a hook process. Any non-zero exit rejects the call, as does a
 * structured `decision: deny` from a clean one; a hook that says nothing lets the
 * call through. Non-zero wins over stdout because the reference formats reserve
 * the exit code for exactly this answer.
 */
export const decodeHookOutcome = (event: HookEvent, process: HookProcess): HookOutcome => {
  const stdout = process.stdout.trim()
  const stderr = process.stderr.trim()
  if (process.timedOut) {
    return { kind: 'deny', reason: 'the ' + event + ' hook timed out', stdout, stderr }
  }
  if (process.exitCode !== 0) {
    return {
      kind: 'deny',
      reason:
        stderr.length > 0
          ? stderr
          : 'the ' + event + ' hook exited with code ' + String(process.exitCode),
      stdout,
      stderr,
    }
  }
  const answer = parsedObject(stdout)
  const denial = answer === undefined ? undefined : structuredDenial(answer, event)
  return denial === undefined
    ? { kind: 'pass', stdout, stderr }
    : { kind: 'deny', reason: denial, stdout, stderr }
}

/** The JSON a hook reads from stdin: the event, the tool, its decoded input, and the run. */
export const hookPayload = (
  event: HookEvent,
  exec: ToolExecution,
  result?: ToolExecutionResult,
): Readonly<Record<string, unknown>> => ({
  session_id: exec.context.sessionId,
  transcript_path: '',
  cwd: exec.context.cwd,
  hook_event_name: event,
  tool_name: exec.tool,
  tool_input: exec.args,
  tool_use_id: exec.callId,
  ...(result === undefined
    ? {}
    : {
        tool_response: {
          is_error: result.isError,
          content: result.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('\n'),
        },
      }),
})

const runProcess = (
  argv: ReadonlyArray<string>,
  cwd: string,
  input: string,
  timeoutMs: number,
): Effect.Effect<HookProcess> =>
  Effect.tryPromise({
    try: async () => {
      const child = spawn(argv, { cwd, stdin: 'pipe' })
      child.stdin.write(input)
      child.stdin.end()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        return { exitCode, stdout, stderr, timedOut }
      } finally {
        clearTimeout(timer)
      }
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        exitCode: 1,
        stdout: '',
        stderr: cause instanceof Error ? cause.message : String(cause),
        timedOut: false,
      }),
    ),
  )

const failure = (reason: string): HookOutcome => ({
  kind: 'deny',
  reason,
  stdout: '',
  stderr: '',
})

/**
 * Runs one configured command through the run sandbox. The payload is trusted
 * text this process builds, and the command's own output is data: it is decoded,
 * never evaluated. A command the sandbox refuses cannot guard the call, so the
 * call is denied instead of running unguarded.
 */
export const runHookCommand = (
  sandbox: SandboxShape,
  hook: HookCommand,
  payload: Readonly<Record<string, unknown>>,
  cwd: string,
  defaultTimeoutMs: number,
): Effect.Effect<HookOutcome> =>
  Effect.gen(function* () {
    const confined = yield* sandbox.wrap({ argv: ['bash', '-c', hook.command], cwd }).pipe(
      Effect.match({
        onFailure: (error) => failure(error.message),
        onSuccess: (value) => value,
      }),
    )
    if ('kind' in confined) return confined
    const process = yield* runProcess(
      confined.argv,
      confined.cwd,
      JSON.stringify(payload) + '\n',
      hook.timeoutMs ?? defaultTimeoutMs,
    )
    return decodeHookOutcome(hook.event, process)
  })
