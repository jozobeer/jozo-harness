import { HooksLive } from '@jozo-harness/kernel'
import { Tools, toolsLayer } from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { jobTools, makeJobs } from '../src/index.ts'
import { makeBashTool } from '../../tools-tier0/src/bash.ts'

/** The id a job_start call returned, or the failure the test should not hide. */
const startedIdOf = (result: { readonly value?: unknown } | undefined): string => {
  const value = result?.value as { readonly id?: unknown } | undefined
  if (typeof value?.id !== 'string') throw new Error('job_start returned no id')
  return value.id
}

describe('job tools', () => {
  test('start, read, and stop a background command', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeJobs()
          const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
          const tools = Context.get(context, Tools)
          for (const tool of jobTools(jobs)) yield* tools.register(tool)

          const call = (name: string, args: unknown) =>
            tools.call({
              callId: 'c-' + name,
              tool: name,
              arguments: JSON.stringify(args),
              context: { sessionId: 's1', cwd: '/tmp', callId: 'c-' + name },
            })

          const started = yield* call('job_start', { command: 'echo from a job' })
          const id = startedIdOf(started)
          yield* Effect.sleep('200 millis')
          const read = yield* call('job_output', { id })
          const killed = yield* call('job_kill', { id })
          return { started: started?.value, read: read?.value, killed }
        }),
      ),
    )

    expect(observed.started).toEqual({
      id: expect.stringMatching(/^job-[0-9a-f]{8}$/),
      command: 'echo from a job',
    })
    expect(JSON.stringify(observed.read)).toContain('from a job')
    expect(observed.killed?.isError).toBe(false)
  })

  test('a bash call that times out is promoted to a job that job_output reads', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeJobs()
          const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
          const tools = Context.get(context, Tools)
          for (const tool of [...jobTools(jobs), makeBashTool(undefined, undefined, jobs)]) {
            yield* tools.register(tool)
          }

          const call = (name: string, args: unknown) =>
            tools.call({
              callId: 'c-' + name,
              tool: name,
              arguments: JSON.stringify(args),
              context: { sessionId: 's1', cwd: '/tmp', callId: 'c-' + name },
            })

          const timedOut = yield* call('bash', {
            command: 'sleep 0.6; echo survived',
            timeoutMs: 200,
          })
          const value = timedOut?.value as { jobId?: string } | undefined
          const read =
            value?.jobId === undefined
              ? undefined
              : yield* call('job_output', { id: value.jobId, wait: true, timeoutMs: 5_000 })
          // The output arrives before the exit, so one more read sees it stop.
          const stopped =
            value?.jobId === undefined
              ? undefined
              : yield* call('job_output', { id: value.jobId, wait: true, timeoutMs: 5_000 })
          return { id: value?.jobId, timedOut, read, stopped }
        }),
      ),
    )

    expect(observed.id).toMatch(/^job-[0-9a-f]{8}$/)
    expect(JSON.stringify(observed.timedOut?.content)).toContain(
      'still running as job ' + observed.id,
    )
    expect(JSON.stringify(observed.read?.value)).toContain('survived')
    expect(JSON.stringify(observed.stopped?.content)).toContain('[finished]')
  })

  test('one waited read returns only what the job produced since the last read', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeJobs()
          const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
          const tools = Context.get(context, Tools)
          for (const tool of jobTools(jobs)) yield* tools.register(tool)

          const call = (name: string, args: unknown) =>
            tools.call({
              callId: 'c-' + name,
              tool: name,
              arguments: JSON.stringify(args),
              context: { sessionId: 's1', cwd: '/tmp', callId: 'c-' + name },
            })

          const running = yield* call('job_start', {
            command: 'echo first && sleep 0.4 && echo second',
          })
          const id = startedIdOf(running)
          yield* Effect.sleep('200 millis')
          const first = yield* call('job_output', { id, wait: false })
          const waited = yield* call('job_output', { id, wait: true, timeoutMs: 5_000 })
          return {
            first: JSON.stringify(first?.value),
            waited: JSON.stringify(waited?.value),
            content: JSON.stringify(waited?.content),
          }
        }),
      ),
    )

    expect(observed.first).toContain('"running":true')
    expect(observed.first).toContain('first')
    expect(observed.waited).toContain('second')
    expect(observed.waited).toContain('"truncated":false')
    expect(observed.waited).not.toContain('first')
    expect(observed.content).toContain('second')
  })

  test('lists what is running and what has stopped', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeJobs()
          const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
          const tools = Context.get(context, Tools)
          for (const tool of jobTools(jobs)) yield* tools.register(tool)

          const call = (name: string, args: unknown) =>
            tools.call({
              callId: 'c-' + name,
              tool: name,
              arguments: JSON.stringify(args),
              context: { sessionId: 's1', cwd: '/tmp', callId: 'c-' + name },
            })

          const empty = yield* call('job_list', {})
          const slow = yield* call('job_start', { command: 'sleep 5' })
          const fast = yield* call('job_start', { command: 'echo done' })
          const slowId = startedIdOf(slow)
          const fastId = startedIdOf(fast)
          yield* Effect.sleep('200 millis')
          const listed = yield* call('job_list', {})
          yield* call('job_kill', { id: slowId })
          return { empty, listed: listed?.value, content: listed?.content, slowId, fastId }
        }),
      ),
    )

    expect(JSON.stringify(observed.empty?.content)).toContain('no background jobs')
    expect(observed.listed).toEqual([
      { id: observed.slowId, command: 'sleep 5', running: true },
      { id: observed.fastId, command: 'echo done', running: false },
    ])
    expect(JSON.stringify(observed.content)).toContain(observed.slowId + ' running: sleep 5')
    expect(JSON.stringify(observed.content)).toContain(observed.fastId + ' finished: echo done')
  })
})
