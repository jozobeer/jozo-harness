import type { JobsShape } from '@jozo-harness/tools-tier1'
import type { JobDetailView, RunStateView } from '@jozo-harness/web'
import { WebError } from '@jozo-harness/web'
import { Effect } from 'effect'

/** How much of a job's newest line the Run pane shows, so one row stays one row. */
export const JOB_TAIL_LIMIT = 200

/** The end of the last line the job produced: what the Run pane shows in its row. */
export const tailOf = (output: string): string => {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const last = lines.at(-1) ?? ''
  return last.length <= JOB_TAIL_LIMIT ? last : '…' + last.slice(-(JOB_TAIL_LIMIT - 1))
}

/** The jobs the session started, as the Run pane lists them now. */
export const jobsOf = (jobs: JobsShape): RunStateView['jobs'] =>
  jobs.list().map((job) => ({
    id: job.id,
    command: job.command,
    running: job.running,
    startedAt: job.startedAt,
    tail: tailOf(job.output),
  }))

/** What one background command has kept as output, without consuming it. */
export const jobDetailOf = (jobs: JobsShape, id: string): Effect.Effect<JobDetailView, WebError> =>
  jobs.snapshot(id).pipe(
    Effect.map((job) => ({
      id: job.id,
      command: job.command,
      running: job.running,
      output: job.output,
    })),
    Effect.mapError((error) => new WebError({ message: error.message })),
  )

/** Stops one background command; a job that already ended is not an error. */
export const stopJobOf = (jobs: JobsShape, id: string): Effect.Effect<void, WebError> =>
  jobs.kill(id).pipe(Effect.mapError((error) => new WebError({ message: error.message })))
