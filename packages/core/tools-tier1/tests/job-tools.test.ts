import { HooksLive } from '@jozo-harness/kernel'
import { Tools, toolsLayer } from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { jobTools, makeJobs } from '../src/index.ts'

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
          yield* Effect.sleep('200 millis')
          const read = yield* call('job_output', { id: 'job-1' })
          const killed = yield* call('job_kill', { id: 'job-1' })
          return { started: started?.value, read: read?.value, killed }
        }),
      ),
    )

    expect(observed.started).toEqual({ id: 'job-1', command: 'echo from a job' })
    expect(JSON.stringify(observed.read)).toContain('from a job')
    expect(observed.killed?.isError).toBe(false)
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

          yield* call('job_start', { command: 'echo first && sleep 0.4 && echo second' })
          yield* Effect.sleep('200 millis')
          const first = yield* call('job_output', { id: 'job-1', wait: false })
          const waited = yield* call('job_output', { id: 'job-1', wait: true, timeoutMs: 5_000 })
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
          yield* call('job_start', { command: 'sleep 5' })
          yield* call('job_start', { command: 'echo done' })
          yield* Effect.sleep('200 millis')
          const listed = yield* call('job_list', {})
          yield* call('job_kill', { id: 'job-1' })
          return { empty, listed: listed?.value, content: listed?.content }
        }),
      ),
    )

    expect(JSON.stringify(observed.empty?.content)).toContain('no background jobs')
    expect(observed.listed).toEqual([
      { id: 'job-1', command: 'sleep 5', running: true },
      { id: 'job-2', command: 'echo done', running: false },
    ])
    expect(JSON.stringify(observed.content)).toContain('job-1 running: sleep 5')
    expect(JSON.stringify(observed.content)).toContain('job-2 finished: echo done')
  })
})
