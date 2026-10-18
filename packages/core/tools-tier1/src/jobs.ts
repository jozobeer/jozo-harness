import { Effect } from 'effect'
import { ToolError } from '@jozo-harness/tools'
import { spawn, type Child } from '@jozo-harness/process'

export interface Job {
  readonly id: string
  readonly command: string
  running: boolean
  output: string
}

/** What one read of a job returns: the output produced since the previous read. */
export interface JobRead {
  readonly id: string
  readonly command: string
  readonly running: boolean
  readonly output: string
  /** True when the job produced more than a read could return, so part of its output is lost. */
  readonly truncated: boolean
}

export interface JobReadOptions {
  /** How long to wait for output the job has not produced yet. Zero reads what is buffered now. */
  readonly waitMs?: number
}

export interface JobsShape {
  /** Starts a command in the background and returns its handle. */
  readonly start: (command: string, cwd: string) => Effect.Effect<Job, ToolError>
  /** Takes over a child a timed-out call already spawned, so its work is not lost. */
  readonly promote: (command: string, child: Child) => Effect.Effect<Job, ToolError>
  /** Reads what the job produced since the previous read, waiting up to `waitMs` for more. */
  readonly read: (id: string, options?: JobReadOptions) => Effect.Effect<JobRead, ToolError>
  readonly kill: (id: string) => Effect.Effect<void, ToolError>
  readonly list: () => ReadonlyArray<Job>
}

/** How much output one job keeps in memory. */
export const JOB_OUTPUT_LIMIT = 64_000

/**
 * Background commands. Output is kept in memory up to a limit and the process
 * is killed explicitly; jobs do not survive the command that started them.
 */
export const makeJobs = (): Effect.Effect<JobsShape> =>
  Effect.sync(() => {
    interface Entry {
      readonly job: Job
      readonly process: Child
      /** How many characters the job has produced, whatever the buffer still holds. */
      produced: number
      /** How many of them a read has already returned. */
      seen: number
      /** Called when the job produces output or stops, so a waiting read can return. */
      readonly wake: Array<() => void>
    }
    const jobs = new Map<string, Entry>()
    let counter = 0

    const notify = (entry: Entry): void => {
      for (const resolve of entry.wake.splice(0, entry.wake.length)) resolve()
    }

    const collect = (entry: Entry, stream: ReadableStream<Uint8Array>): void => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      void (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value === undefined) continue
          const text = decoder.decode(value)
          entry.produced += text.length
          entry.job.output = (entry.job.output + text).slice(-JOB_OUTPUT_LIMIT)
          notify(entry)
        }
      })()
    }

    /** Registers a child under a fresh job id; the caller owns how the child was spawned. */
    const register = (command: string, child: Child): Job => {
      counter += 1
      const id = 'job-' + String(counter)
      const job: Job = { id, command, running: true, output: '' }
      const entry: Entry = { job, process: child, produced: 0, seen: 0, wake: [] }
      collect(entry, child.stdout)
      collect(entry, child.stderr)
      void child.exited.then(() => {
        job.running = false
        notify(entry)
      })
      jobs.set(id, entry)
      return job
    }

    /** Resolves on output the reader has not seen, on the job stopping, or on the wait running out. */
    const waitForChange = (entry: Entry, waitMs: number): Promise<void> =>
      new Promise((resolve) => {
        if (waitMs <= 0 || entry.produced > entry.seen || !entry.job.running) {
          resolve()
          return
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = (): void => {
          const index = entry.wake.indexOf(done)
          if (index >= 0) entry.wake.splice(index, 1)
          if (timer !== undefined) clearTimeout(timer)
          resolve()
        }
        timer = setTimeout(done, waitMs)
        entry.wake.push(done)
      })

    return {
      start: (command, cwd) =>
        Effect.sync(() =>
          register(
            command,
            spawn(['bash', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' }),
          ),
        ),
      promote: (command, child) => Effect.sync(() => register(command, child)),
      read: (id, options) =>
        Effect.gen(function* () {
          const entry = jobs.get(id)
          if (entry === undefined) {
            return yield* Effect.fail(
              new ToolError({ code: 'execution', message: 'unknown job: ' + id }),
            )
          }
          const waitMs = Math.max(options?.waitMs ?? 0, 0)
          if (waitMs > 0) yield* Effect.promise(() => waitForChange(entry, waitMs))
          const buffered = entry.job.output.length
          const unseen = entry.produced - entry.seen
          const output = entry.job.output.slice(Math.max(buffered - unseen, 0))
          entry.seen = entry.produced
          return {
            id: entry.job.id,
            command: entry.job.command,
            running: entry.job.running,
            output,
            truncated: unseen > buffered,
          }
        }),
      kill: (id) =>
        Effect.gen(function* () {
          const entry = jobs.get(id)
          if (entry === undefined) {
            return yield* Effect.fail(
              new ToolError({ code: 'execution', message: 'unknown job: ' + id }),
            )
          }
          entry.process.kill()
          entry.job.running = false
        }),
      list: () => [...jobs.values()].map((entry) => entry.job),
    }
  })
