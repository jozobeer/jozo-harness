import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { Schema, Effect } from 'effect'
import { ToolError, oneLine, type ToolDefinition } from '@jozo-harness/tools'
import {
  ESCALATION_TARGETS,
  classifySandboxFailure,
  escalationHintMarker,
  noneSandbox,
  sandboxApplyFailureMarker,
  sandboxDenialMarker,
  type ApprovalShape,
  type SandboxFailure,
  type SandboxMode,
  type SandboxShape,
} from '@jozo-harness/safety'
import { spawn, type Child } from '@jozo-harness/process'
import { escalates, escalationFields, modeOfCall } from './escalation.ts'
import { resolveInside } from './workspace.ts'
import { exitSummaryOf } from './present.ts'

/** A command that has not finished by then is promoted to a job, or killed when there is none. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000
/** The longest a caller may ask for; a command beyond this is background work. */
export const BASH_MAX_TIMEOUT_MS = 600_000
/** After the soft kill, a command that ignores it gets this long before the hard one. */
export const BASH_HARD_KILL_GRACE_MS = 5_000

/** The shells one call can run in. PowerShell goes through the same executor and sandbox as bash. */
export const SHELLS = ['bash', 'powershell'] as const

export type ShellName = (typeof SHELLS)[number]

/** The program a shell runs, and the flags that carry one script to it. */
const SHELL_INVOCATION: Record<
  ShellName,
  { readonly program: string; readonly flags: ReadonlyArray<string> }
> = {
  bash: { program: 'bash', flags: ['-c'] },
  // A PowerShell profile would read a host file the workspace does not hold, and -Command takes one string.
  powershell: { program: 'pwsh', flags: ['-NoProfile', '-Command'] },
}

/** The argv that runs one script in the chosen shell, before any sandbox wraps it. */
export const shellArgv = (shell: ShellName, script: string): ReadonlyArray<string> => [
  SHELL_INVOCATION[shell].program,
  ...SHELL_INVOCATION[shell].flags,
  script,
]

/** Whether a shell can run here; tests replace this so they need no real pwsh. */
export type ShellAvailability = (shell: ShellName) => boolean

/** True when the program is an executable file on PATH. */
const executableOnPath = (program: string): boolean =>
  (process.env.PATH ?? '').split(delimiter).some((directory) => {
    const candidate = join(directory, program)
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })

/**
 * The default availability: bash is what the executor has always spawned, while
 * an added shell is looked up first so a host without it fails with a reason.
 */
export const shellOnPath: ShellAvailability = (shell) =>
  shell === 'bash' || executableOnPath(SHELL_INVOCATION[shell].program)

/** What a call says when the shell it asked for is not installed: the missing program and the way out. */
export const missingShellMessage = (shell: ShellName): string =>
  shell +
  ': ' +
  SHELL_INVOCATION[shell].program +
  ' was not found on PATH. Install PowerShell 7, or run the command in bash.'

/** A live child the job registry takes over when a call runs out of time. */
export interface TimeoutJobs {
  readonly promote: (
    command: string,
    child: Child,
    cwd?: string,
  ) => Effect.Effect<{ readonly id: string }, ToolError>
}

const Parameters = Schema.Struct({
  command: Schema.String.annotate({ description: 'The shell command line to run.' }),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The directory to run in, inside the workspace. Defaults to the current working directory.',
    }),
  ),
  timeoutMs: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        'Kill the command after this many milliseconds. Defaults to 120000; the most allowed is 600000.',
    }),
  ),
  shell: Schema.optionalKey(
    Schema.Literals(SHELLS).annotate({
      description:
        'The shell that runs the command, inside the same sandbox either way. Defaults to bash; powershell runs it through pwsh -NoProfile -Command.',
    }),
  ),
  ...escalationFields('a command', 'command'),
})

export type BashArgs = Schema.Schema.Type<typeof Parameters>

export interface BashValue {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly timeoutMs: number
  /** The job a timed-out command was handed to, when the run has a job registry. */
  readonly jobId?: string
  /** The mode the command ran under, and what the sandbox said about the run. */
  readonly sandbox: {
    readonly mode: SandboxMode
    readonly failure: SandboxFailure
  }
}

/** The timeout a call actually gets: a default, never more than the tool allows. */
export const clampTimeout = (asked: number | undefined): number => {
  if (asked === undefined) return BASH_DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(asked, 1), BASH_MAX_TIMEOUT_MS)
}

interface Run {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly timeoutMs: number
  readonly jobId?: string
}

/** The output of a child that has stopped, read without locking the streams of one still running. */
const outputOf = async (child: Child): Promise<{ stdout: string; stderr: string }> => {
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { stdout, stderr }
}

/** True when the child stopped before the timeout, false when the time ran out. */
const stoppedInTime = (child: Child, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void child.exited.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(true)
      },
    )
  })

/** Sends the soft signal, then the hard one, and waits for the child to stop. */
const killWrapped = async (child: Child): Promise<number> => {
  child.kill()
  // A command may trap the soft signal; the hard one is not optional.
  const hard = setTimeout(() => child.kill(9), BASH_HARD_KILL_GRACE_MS)
  const exitCode = await child.exited
  clearTimeout(hard)
  return exitCode
}

/** Runs the wrapped command and kills it at the timeout: the path for a run without a job registry. */
const runToKill = async (
  wrapped: { readonly argv: ReadonlyArray<string>; readonly cwd: string },
  timeoutMs: number,
): Promise<Run> => {
  const child = spawn([...wrapped.argv], {
    cwd: wrapped.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timedOut = !(await stoppedInTime(child, timeoutMs))
  const exitCode = timedOut ? await killWrapped(child) : await child.exited
  return { exitCode, ...(await outputOf(child)), timedOut, timeoutMs }
}

/**
 * Runs the wrapped command and, at the timeout, hands the still-running child to
 * the job registry instead of killing it. A registry that refuses the child is
 * not a reason to leave it running: the kill path is the fallback.
 */
const runToPromote = async (
  wrapped: { readonly argv: ReadonlyArray<string>; readonly cwd: string },
  timeoutMs: number,
  command: string,
  jobs: TimeoutJobs,
): Promise<Run> => {
  const child = spawn([...wrapped.argv], {
    cwd: wrapped.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (await stoppedInTime(child, timeoutMs)) {
    return { exitCode: await child.exited, ...(await outputOf(child)), timedOut: false, timeoutMs }
  }
  try {
    const job = await Effect.runPromise(jobs.promote(command, child, wrapped.cwd))
    return { exitCode: 0, stdout: '', stderr: '', timedOut: true, timeoutMs, jobId: job.id }
  } catch {
    const exitCode = await killWrapped(child)
    return { exitCode, ...(await outputOf(child)), timedOut: true, timeoutMs }
  }
}

/** Runs the wrapped command; a timeout promotes it when the run has jobs, and kills it otherwise. */
const runWrapped = async (
  wrapped: { readonly argv: ReadonlyArray<string>; readonly cwd: string },
  timeoutMs: number,
  command: string,
  jobs: TimeoutJobs | undefined,
): Promise<Run> =>
  jobs === undefined
    ? runToKill(wrapped, timeoutMs)
    : runToPromote(wrapped, timeoutMs, command, jobs)

/** The output as the model reads it, before anything is said about the run. */
const bodyOf = (value: BashValue): string => {
  if (value.stderr === '') {
    return value.stdout === '' ? '(no output)' : value.stdout
  }
  const separated =
    value.stdout.length > 0 && !value.stdout.endsWith('\n') ? value.stdout + '\n' : value.stdout
  return separated + '[stderr]\n' + value.stderr
}

/** What the run itself has to say: a timeout, the exit code, and a sandbox denial. */
const timeoutMarker = (value: BashValue): string =>
  value.jobId === undefined
    ? '[timed out after ' + String(value.timeoutMs) + 'ms]'
    : '[timed out after ' +
      String(value.timeoutMs) +
      'ms; still running as job ' +
      value.jobId +
      ']'

const markersOf = (value: BashValue, escalation: boolean): ReadonlyArray<string> => [
  ...(value.timedOut ? [timeoutMarker(value)] : []),
  // A promoted job has no exit code yet; the job id is what the caller acts on.
  ...(value.jobId === undefined && value.exitCode !== 0
    ? ['[exit code: ' + String(value.exitCode) + ']']
    : []),
  ...(value.sandbox.failure === 'denied' ? [sandboxDenialMarker(value.sandbox.mode)] : []),
  ...(value.sandbox.failure === 'denied' && escalation ? [escalationHintMarker('command')] : []),
  // An unapplicable sandbox is not a denial, so it offers no wider mode to retry in.
  ...(value.sandbox.failure === 'apply-failed' ? [sandboxApplyFailureMarker] : []),
]

const renderOutput = (value: BashValue, escalation: boolean): string => {
  const body = bodyOf(value)
  const markers = markersOf(value, escalation)
  if (markers.length === 0) return body
  return (body.endsWith('\n') ? body : body + '\n') + markers.join('\n')
}

/** Runs one shell command, wrapped by the sandbox the caller chose. A non-zero exit is a result to read, not a failed call. */
export const makeBashTool = (
  sandbox: SandboxShape = noneSandbox,
  approval?: ApprovalShape,
  jobs?: TimeoutJobs,
  shells: ShellAvailability = shellOnPath,
): ToolDefinition<BashArgs, BashValue> => {
  const canEscalate = escalates(sandbox, approval)
  return {
    name: 'bash',
    presentCall: (args) => ({
      summary: (args.shell ?? 'bash') + ' ' + oneLine(args.command).slice(0, 120),
    }),
    presentResult: (_args, result) => ({ ...result, summary: exitSummaryOf(result.summary) }),
    description:
      'Runs a shell command in the workspace through the configured sandbox and returns what it printed. The shell is bash unless the call asks for powershell, which needs pwsh installed. Check the [exit code: N] marker: a non-zero exit means the command failed. A command still running at the timeout is handed to a background job and marked with its id, so read it with job_output; without a job registry it is killed and marked. When the output was spilled, read the saved file with offset and limit to see the rest.' +
      (sandbox.confines
        ? ' A file effect the sandbox refuses is reported as `[sandbox: file access denied under <mode> mode]`: that is a policy denial, so do not retry another way.'
        : ''),
    parameters: Parameters,
    output: {
      schema: Schema.Struct({
        exitCode: Schema.Int,
        stdout: Schema.String,
        stderr: Schema.String,
        timedOut: Schema.Boolean,
        timeoutMs: Schema.Int,
        jobId: Schema.optionalKey(Schema.String),
        sandbox: Schema.Struct({
          mode: Schema.Literals([...ESCALATION_TARGETS, 'read-only']),
          failure: Schema.Literals(['none', 'denied', 'apply-failed']),
        }),
      }),
      render: (_args, value) => [{ type: 'text', text: renderOutput(value, canEscalate) }],
    },
    execute: (args, context) =>
      Effect.gen(function* () {
        const shell = args.shell ?? 'bash'
        // A missing shell is the call's failure, not an infrastructure one: the model can pick bash instead.
        if (!shells(shell)) {
          return yield* Effect.fail(
            new ToolError({ code: 'execution', message: missingShellMessage(shell) }),
          )
        }
        const cwd =
          args.cwd === undefined ? context.cwd : yield* resolveInside(context.cwd, args.cwd)
        const mode = yield* modeOfCall({
          args: args,
          callId: context.callId,
          tool: 'bash',
          subject: 'command',
          sandbox,
          approval,
        })
        const wrapped = yield* sandbox
          .wrap({ argv: shellArgv(shell, args.command), cwd, mode })
          .pipe(
            Effect.mapError(
              (error) => new ToolError({ code: 'execution', message: 'sandbox: ' + error.message }),
            ),
          )
        // A sandbox that refuses the command is an infrastructure failure; a command
        // that runs and exits non-zero is not.
        const run = yield* Effect.tryPromise({
          try: () => runWrapped(wrapped, clampTimeout(args.timeoutMs), args.command, jobs),
          catch: () => new ToolError({ code: 'execution', message: 'cannot run: ' + args.command }),
        })
        return {
          ...run,
          sandbox: {
            mode: wrapped.mode,
            failure: classifySandboxFailure(run.exitCode, run.stderr, wrapped.denialSignatures),
          },
        }
      }),
  }
}

export const bashTool = makeBashTool()
