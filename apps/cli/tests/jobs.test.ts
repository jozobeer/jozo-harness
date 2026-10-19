import { describe, expect, test } from 'vitest'
import { ToolError } from '@jozo-harness/tools'
import type { Job, JobRead, JobsShape } from '@jozo-harness/tools-tier1'
import { Effect } from 'effect'
import type { Session } from '@jozo-harness/session'
import {
  JOB_TAIL_LIMIT,
  jobDetailOf,
  jobRecorderOf,
  jobsOf,
  stopJobOf,
  tailOf,
} from '../src/jobs.ts'

/** A job as the registry holds one, with only the fields a test cares about named. */
const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  command: 'pnpm test',
  running: true,
  startedAt: 1_700_000_000_000,
  output: '',
  ...overrides,
})

/** The registry read-only, so a projection can be tested without starting a process. */
const stubJobs = (
  jobs: ReadonlyArray<Job>,
  kill: (id: string) => Effect.Effect<void, ToolError> = () => Effect.void,
  snapshot: (id: string) => Effect.Effect<JobRead, ToolError> = () => Effect.die('not used'),
): JobsShape => ({
  start: () => Effect.die('not used'),
  promote: () => Effect.die('not used'),
  read: () => Effect.die('not used'),
  snapshot,
  kill,
  list: () => jobs,
})

describe('the Run pane job list', () => {
  test('a job carries its id, state, start time, and the end of its output', () => {
    const listed = jobsOf(
      stubJobs([
        job({
          id: 'job-7',
          command: 'pnpm vitest --watch',
          running: true,
          startedAt: 1_700_000_123_456,
          output: 'first line\n\nlast line  \n',
        }),
      ]),
    )

    expect(listed).toEqual([
      {
        id: 'job-7',
        command: 'pnpm vitest --watch',
        running: true,
        startedAt: 1_700_000_123_456,
        tail: 'last line',
      },
    ])
  })

  test('a settled job carries when it stopped, so its row can show how long it took', () => {
    const settled = jobsOf(stubJobs([job({ running: false, endedAt: 1_700_000_005_000 })]))
    const running = jobsOf(stubJobs([job()]))

    expect(settled[0]?.endedAt).toBe(1_700_000_005_000)
    expect(running[0]?.endedAt).toBeUndefined()
  })

  test('a job that produced nothing has no tail', () => {
    expect(tailOf('')).toBe('')
    expect(tailOf('  \n\n')).toBe('')
    expect(jobsOf(stubJobs([job()]))[0]?.tail).toBe('')
  })

  test('a long last line keeps only its end, so one row stays one row', () => {
    const long = 'x'.repeat(JOB_TAIL_LIMIT + 50)
    const tail = tailOf(long)

    expect(tail).toHaveLength(JOB_TAIL_LIMIT)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail.endsWith('x'.repeat(JOB_TAIL_LIMIT - 1))).toBe(true)
  })

  test('opening a job carries all the output the registry kept', async () => {
    const detail = await Effect.runPromise(
      jobDetailOf(
        stubJobs([], undefined, () =>
          Effect.succeed({
            id: 'job-1',
            command: 'pnpm test',
            running: true,
            output: 'one\ntwo',
            truncated: false,
          }),
        ),
        'job-1',
      ),
    )

    expect(detail).toEqual({
      id: 'job-1',
      command: 'pnpm test',
      running: true,
      output: 'one\ntwo',
    })
  })

  test('a job nobody holds is refused when its detail is read', async () => {
    const message = await Effect.runPromise(
      Effect.match(
        jobDetailOf(
          stubJobs([], undefined, () =>
            Effect.fail(new ToolError({ code: 'execution', message: 'unknown job: job-9' })),
          ),
          'job-9',
        ),
        { onFailure: (error) => error.message, onSuccess: () => 'read' },
      ),
    )

    expect(message).toBe('unknown job: job-9')
  })

  test('stopping a job asks the registry for that id', async () => {
    const killed: Array<string> = []
    await Effect.runPromise(
      stopJobOf(
        stubJobs([], (id) =>
          Effect.sync(() => {
            killed.push(id)
          }),
        ),
        'job-9',
      ),
    )

    expect(killed).toEqual(['job-9'])
  })

  test('a job nobody holds reads as a refusal with the registry message', async () => {
    const message = await Effect.runPromise(
      Effect.match(
        stopJobOf(
          stubJobs([], () =>
            Effect.fail(new ToolError({ code: 'execution', message: 'unknown job: job-9' })),
          ),
          'job-9',
        ),
        { onFailure: (error) => error.message, onSuccess: () => 'stopped' },
      ),
    )

    expect(message).toBe('unknown job: job-9')
  })
})

/** A session stub that only records what is appended, as the recorder needs. */
const appendOnly = (
  append: (type: string, data: unknown) => Effect.Effect<void, unknown>,
): Pick<Session, 'append'> => ({ append }) as unknown as Pick<Session, 'append'>

describe('recording job lifecycles into the session log', () => {
  test('two records reach the log in order, one append at a time', async () => {
    const seen: Array<string> = []
    let active = 0
    const recorder = jobRecorderOf(
      appendOnly((type) =>
        Effect.promise(async () => {
          active += 1
          expect(active).toBe(1)
          await new Promise((resolve) => setTimeout(resolve, 5))
          seen.push(type)
          active -= 1
        }),
      ),
    )

    recorder({ type: 'started', id: 'job-1', command: 'true', startedAt: 1 })
    recorder({ type: 'ended', id: 'job-1', endedAt: 2, status: 'exited', exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(seen).toEqual(['job/started', 'job/ended'])
  })

  test('a refused append does not stop the record after it', async () => {
    const seen: Array<string> = []
    const recorder = jobRecorderOf(
      appendOnly((type) =>
        type === 'job/started'
          ? Effect.fail(new Error('disk full'))
          : Effect.sync(() => {
              seen.push(type)
            }),
      ),
    )

    recorder({ type: 'started', id: 'job-1', command: 'true', startedAt: 1 })
    recorder({ type: 'ended', id: 'job-1', endedAt: 2, status: 'killed' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(seen).toEqual(['job/ended'])
  })
})
