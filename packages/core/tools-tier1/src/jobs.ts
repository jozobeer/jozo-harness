import { Effect } from 'effect'
import { ToolError } from '@jozo-harness/tools'
import { spawn, type Child } from '@jozo-harness/process'

export interface Job {
  readonly id: string
  readonly command: string
  readonly startedAt: number
  /** When the job stopped, in ms; unset while it still runs. */
  endedAt?: number
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

/** One lifecycle moment of a job, for the caller to record outside the registry. */
export type JobRecord =
  | {
      readonly type: 'started'
      readonly id: string
      readonly command: string
      readonly cwd?: string
      readonly startedAt: number
    }
  | {
      readonly type: 'ended'
      readonly id: string
      readonly endedAt: number
      /** Whether the command exited on its own or a caller stopped it. */
      readonly status: 'exited' | 'killed'
      /** The exit code of a command that exited; a killed one has none. */
      readonly exitCode?: number
    }

export interface JobsOptions {
  /** Called once when a job starts and once when it settles, so the caller can log it. */
  readonly record?: (record: JobRecord) => void
  /** The environment a background command inherits, with managed values already applied. */
  readonly env?: NodeJS.ProcessEnv
}

export interface JobsShape {
  /** Starts a command in the background and returns its handle. */
  readonly start: (command: string, cwd: string) => Effect.Effect<Job, ToolError>
  /** Takes over a child a timed-out call already spawned, so its work is not lost. */
  readonly promote: (command: string, child: Child, cwd?: string) => Effect.Effect<Job, ToolError>
  /** Reads what the job produced since the previous read, waiting up to `waitMs` for more. */
  readonly read: (id: string, options?: JobReadOptions) => Effect.Effect<JobRead, ToolError>
  /** Reads all the output the job kept so far, leaving it for the next read. */
  readonly snapshot: (id: string) => Effect.Effect<JobRead, ToolError>
  readonly kill: (id: string) => Effect.Effect<void, ToolError>
  readonly list: () => ReadonlyArray<Job>
}

/** How much output one job keeps in memory. */
export const JOB_OUTPUT_LIMIT = 64_000

/**
 * A job id that a later run of the same session cannot hand out again. The log
 * keeps the ids of jobs this process started, so a resumed run reading one gets
 * "unknown job" instead of another command's output.
 */
export const newJobId = (): string => 'job-' + crypto.randomUUID().replaceAll('-', '').slice(0, 8)

/**
 * Background commands. Output is kept in memory up to a limit and the process
 * is killed explicitly; jobs do not survive the command that started them.
 */
export const makeJobs = (options: JobsOptions = {}): Effect.Effect<JobsShape> =>
  Effect.sync(() => {
    interface Entry {
      readonly job: Job
      readonly process: Child
      /** How many characters the job has produced, whatever the buffer still holds. */
      produced: number
      /** How many of them a read has already returned. */
      seen: number
      /** Whether the end of this job is already recorded. */
      settled: boolean
      /** Called when the job produces output or stops, so a waiting read can return. */
      readonly wake: Array<() => void>
    }
    const jobs = new Map<string, Entry>()

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

    /** Records that a job settled, once, so a kill followed by the exit reports one end. */
    const settle = (entry: Entry, status: 'exited' | 'killed', exitCode?: number): void => {
      if (entry.settled) return
      entry.settled = true
      options.record?.({
        type: 'ended',
        id: entry.job.id,
        endedAt: Date.now(),
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
      })
    }

    /** Registers a child under a fresh job id; the caller owns how the child was spawned. */
    const register = (command: string, cwd: string | undefined, child: Child): Job => {
      const id = newJobId()
      const startedAt = Date.now()
      const job: Job = { id, command, startedAt, running: true, output: '' }
      const entry: Entry = { job, process: child, produced: 0, seen: 0, settled: false, wake: [] }
      options.record?.({
        type: 'started',
        id,
        command,
        ...(cwd === undefined ? {} : { cwd }),
        startedAt,
      })
      collect(entry, child.stdout)
      collect(entry, child.stderr)
      void child.exited.then((exitCode) => {
        job.running = false
        job.endedAt = Date.now()
        settle(entry, 'exited', exitCode)
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

    /** The entry of one job, or the refusal a read of an unknown id gets. */
    const entryOf = (id: string): Effect.Effect<Entry, ToolError> => {
      const entry = jobs.get(id)
      return entry === undefined
        ? Effect.fail(new ToolError({ code: 'execution', message: 'unknown job: ' + id }))
        : Effect.succeed(entry)
    }

    return {
      start: (command, cwd) =>
        Effect.sync(() => {
          const environment = options.env
          if (environment !== undefined) {
            const names = Object.keys(environment)
              .filter((name) => name.startsWith('JZH_'))
              .sort()
            if (names.length > 0) process.stderr.write('[managed env] ' + names.join(', ') + '\n')
          }
          return register(
            command,
            cwd,
            spawn(['bash', '-c', command], {
              cwd,
              ...(environment === undefined ? {} : { env: environment }),
              stdout: 'pipe',
              stderr: 'pipe',
            }),
          )
        }),
      promote: (command, child, cwd) => Effect.sync(() => register(command, cwd, child)),
      read: (id, options) =>
        Effect.gen(function* () {
          const entry = yield* entryOf(id)
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
      snapshot: (id) =>
        Effect.gen(function* () {
          const entry = yield* entryOf(id)
          return {
            id: entry.job.id,
            command: entry.job.command,
            running: entry.job.running,
            output: entry.job.output,
            // Part of what the job produced may have fallen out of the kept buffer.
            truncated: entry.produced > entry.job.output.length,
          }
        }),
      kill: (id) =>
        Effect.gen(function* () {
          const entry = yield* entryOf(id)
          entry.process.kill()
          entry.job.running = false
          entry.job.endedAt = Date.now()
          settle(entry, 'killed')
        }),
      list: () => [...jobs.values()].map((entry) => entry.job),
    }
  })
