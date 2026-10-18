import { Schema, Effect } from 'effect'
import type { ToolDefinition } from '@jozo-harness/tools'
import type { JobsShape } from './jobs.ts'

const StartParameters = Schema.Struct({
  command: Schema.String.annotate({ description: 'The shell command line to start.' }),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The directory to run in, inside the workspace. Defaults to the working directory.',
    }),
  ),
})
const IdParameters = Schema.Struct({
  id: Schema.String.annotate({ description: 'The job id a start returned.' }),
})
const ReadParameters = Schema.Struct({
  id: Schema.String.annotate({ description: 'The job id a start returned.' }),
  wait: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        'Whether to wait for output the job has not produced yet. Defaults to true; false returns what is buffered now.',
    }),
  ),
  timeoutMs: Schema.optionalKey(
    Schema.Int.annotate({
      description: 'The most milliseconds to wait. Defaults to 30000 and is capped at 600000.',
    }),
  ),
})

/** How long job_output waits for output unless the caller says otherwise. */
export const JOB_OUTPUT_DEFAULT_WAIT_MS = 30_000
/** The most job_output waits, however the caller asks. */
export const JOB_OUTPUT_MAX_WAIT_MS = 600_000

/** The wait a read asks the registry for, given how the caller wants to read. */
export const jobOutputWaitMs = (args: { wait?: boolean; timeoutMs?: number }): number =>
  args.wait === false
    ? 0
    : Math.min(args.timeoutMs ?? JOB_OUTPUT_DEFAULT_WAIT_MS, JOB_OUTPUT_MAX_WAIT_MS)

/** Starts a command in the background, so long work can overlap with the turn. */
export const makeJobStartTool = (
  jobs: JobsShape,
): ToolDefinition<{ command: string; cwd?: string }, { id: string; command: string }> => ({
  name: 'job_start',
  description:
    'Starts a command in the background and returns its job id. Use it for a command that outlives one call, then read it with job_output.',
  parameters: StartParameters,
  output: {
    schema: Schema.Struct({ id: Schema.String, command: Schema.String }),
    render: (_args, value) => [
      { type: 'text', text: 'started ' + value.id + ': ' + value.command },
    ],
  },
  execute: (args, context) =>
    jobs
      .start(args.command, args.cwd ?? context.cwd)
      .pipe(Effect.map((job) => ({ id: job.id, command: job.command }))),
})

/** Reads what a background job has produced since the previous read, waiting for more if asked. */
export const makeJobOutputTool = (
  jobs: JobsShape,
): ToolDefinition<
  { id: string; wait?: boolean; timeoutMs?: number },
  { id: string; running: boolean; output: string; truncated: boolean }
> => ({
  name: 'job_output',
  presentCall: (args) => ({ summary: 'job_output ' + args.id }),
  description:
    'Reads the output a background job has produced since the last read of it. Waits for a running job to produce more, up to timeoutMs, instead of polling; job_kill stops one that no longer matters.',
  parameters: ReadParameters,
  output: {
    schema: Schema.Struct({
      id: Schema.String,
      running: Schema.Boolean,
      output: Schema.String,
      truncated: Schema.Boolean,
    }),
    render: (_args, value) => [
      {
        type: 'text',
        text:
          (value.output === '' ? '(no new output)' : value.output) +
          (value.truncated ? '\n[earlier output dropped before it could be read]' : '') +
          (value.running ? '\n[running]' : '\n[finished]'),
      },
    ],
  },
  execute: (args) =>
    jobs.read(args.id, { waitMs: jobOutputWaitMs(args) }).pipe(
      Effect.map((job) => ({
        id: job.id,
        running: job.running,
        output: job.output,
        truncated: job.truncated,
      })),
    ),
})

/** Stops a background job. */
export const makeJobKillTool = (
  jobs: JobsShape,
): ToolDefinition<{ id: string }, { id: string }> => ({
  name: 'job_kill',
  description:
    'Stops a background job and returns what it had produced. Use it when the job no longer matters, so its process does not outlive the work.',
  parameters: IdParameters,
  output: {
    schema: Schema.Struct({ id: Schema.String }),
    render: (_args, value) => [{ type: 'text', text: 'stopped ' + value.id }],
  },
  execute: (args) => jobs.kill(args.id).pipe(Effect.map(() => ({ id: args.id }))),
})

/** One background job as the model sees it in the list. */
export interface JobSummary {
  readonly id: string
  readonly command: string
  readonly running: boolean
}

const jobLine = (job: JobSummary): string =>
  job.id + (job.running ? ' running: ' : ' finished: ') + job.command

/** Lists the background jobs, so work already running is visible before more is started. */
export const makeJobListTool = (
  jobs: JobsShape,
): ToolDefinition<Record<string, never>, ReadonlyArray<JobSummary>> => ({
  name: 'job_list',
  description:
    'Lists the background jobs this session started and whether each is still running. Use it before starting work that may already be running, and to find the id of a job to read or stop.',
  parameters: Schema.Struct({}),
  output: {
    schema: Schema.Array(
      Schema.Struct({ id: Schema.String, command: Schema.String, running: Schema.Boolean }),
    ),
    render: (_args, value) => [
      {
        type: 'text',
        text: value.length === 0 ? '(no background jobs)' : value.map(jobLine).join('\n'),
      },
    ],
  },
  execute: () =>
    Effect.sync(() =>
      jobs.list().map((job) => ({ id: job.id, command: job.command, running: job.running })),
    ),
})

/** The background job tools over one registry the caller owns. */
export const jobTools = (jobs: JobsShape): ReadonlyArray<ToolDefinition<any, any>> => [
  makeJobStartTool(jobs),
  makeJobOutputTool(jobs),
  makeJobKillTool(jobs),
  makeJobListTool(jobs),
]
