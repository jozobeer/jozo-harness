import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { makeJobs } from '../src/index.ts'

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
