import { describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { makeJobs } from '../src/index.ts'

/** Waits for a child to create a marker file, or reports that it never did. */
const waitForFile = async (path: string, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return existsSync(path)
}

describe('jobs', () => {
  test('starts a command, reads its output, and stops it', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* makeJobs()
        const running = yield* jobs.start('echo hello && sleep 5', '/tmp')
        yield* Effect.sleep('200 millis')
        const read = yield* jobs.read(running.id)
        const listed = jobs.list().map((job) => job.id)
        yield* jobs.kill(running.id)
        yield* Effect.sleep('50 millis')
        const after = yield* jobs.read(running.id)
        return { output: read.output, listed, running: after.running }
      }),
    )

    expect(observed.output).toContain('hello')
    expect(observed.listed).toEqual(['job-1'])
    expect(observed.running).toBe(false)
  })

  test('killing a job ends the descendants its command started', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-jobs-'))
    const ready = join(directory, 'grandchild-ready')
    const stopped = join(directory, 'grandchild-stopped')
    try {
      const command = `bash -c 'trap "touch ${stopped}" TERM; touch ${ready}; sleep 30' & wait`
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const jobs = yield* makeJobs()
          const running = yield* jobs.start(command, '/tmp')
          const started = yield* Effect.promise(() => waitForFile(ready))
          yield* jobs.kill(running.id)
          const ended = yield* Effect.promise(() => waitForFile(stopped))
          return { started, ended }
        }),
      )
      expect(observed.started).toBe(true)
      expect(observed.ended).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test('a job runs in a non-login shell', async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* makeJobs()
        const running = yield* jobs.start(
          'if shopt -q login_shell; then echo login; else echo nonlogin; fi',
          '/tmp',
        )
        const read = yield* jobs.read(running.id, { waitMs: 5_000 })
        yield* jobs.kill(running.id)
        return read.output
      }),
    )

    expect(output).toContain('nonlogin')
  })

  test('a later read returns only what the job produced since the previous read', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* makeJobs()
        const running = yield* jobs.start('echo first && sleep 5', '/tmp')
        yield* Effect.sleep('300 millis')
        const first = yield* jobs.read(running.id)
        const second = yield* jobs.read(running.id)
        yield* jobs.kill(running.id)
        return { first: first.output, second: second.output }
      }),
    )

    expect(observed.first).toContain('first')
    expect(observed.second).not.toContain('first')
  })

  test('a read waits for output the job has not produced yet', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* makeJobs()
        const running = yield* jobs.start('sleep 0.4 && echo late', '/tmp')
        const now = yield* jobs.read(running.id)
        const waited = yield* jobs.read(running.id, { waitMs: 5_000 })
        yield* jobs.kill(running.id)
        return { now: now.output, waited: waited.output }
      }),
    )

    expect(observed.now).not.toContain('late')
    expect(observed.waited).toContain('late')
  })

  test('a job records when it started and a snapshot reads all it kept', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* makeJobs()
        const before = Date.now()
        const running = yield* jobs.start('echo held', '/tmp')
        yield* Effect.sleep('250 millis')
        const snapshot = yield* jobs.snapshot(running.id)
        const read = yield* jobs.read(running.id)
        const again = yield* jobs.snapshot(running.id)
        yield* jobs.kill(running.id)
        return {
          startedAt: running.startedAt,
          before,
          snapshot: snapshot.output,
          read: read.output,
          again: again.output,
        }
      }),
    )

    expect(observed.startedAt).toBeGreaterThanOrEqual(observed.before)
    expect(observed.snapshot).toContain('held')
    expect(observed.read).toContain('held')
    // A snapshot reads what the job kept without consuming it, so the Run pane
    // can read the same output again a second later.
    expect(observed.again).toContain('held')
  })

  test('an unknown job is an error', async () => {
    const failed = await Effect.runPromise(
      Effect.gen(function* () {
        const jobs = yield* makeJobs()
        return yield* Effect.match(jobs.read('nope'), {
          onFailure: (error) => error.message,
          onSuccess: () => 'ok',
        })
      }),
    )

    expect(failed).toContain('unknown job')
  })
})
