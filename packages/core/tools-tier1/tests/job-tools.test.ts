import { HooksLive } from '@jozo-harness/kernel'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import { Tools, toolsLayer } from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { jobTools, makeJobStartTool, makeJobs, type JobsShape } from '../src/index.ts'
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

interface RecordedLaunch {
  readonly command: string
  readonly cwd: string
  readonly argv?: ReadonlyArray<string>
}

/** A registry that records what job_start asked to spawn and starts nothing. */
const recordingJobs = (launches: Array<RecordedLaunch>): JobsShape => ({
  start: (command, cwd, argv) =>
    Effect.sync(() => {
      launches.push(argv === undefined ? { command, cwd } : { command, cwd, argv })
      return { id: 'job-aabbccdd', command, startedAt: 0, running: true, output: '' }
    }),
  promote: () => Effect.die('unused'),
  read: () => Effect.die('unused'),
  snapshot: () => Effect.die('unused'),
  kill: () => Effect.die('unused'),
  list: () => [],
})

/** A sandbox that prefixes the helper the way a real one would, and records the call. */
const confiningSandbox = (): SandboxShape => ({
  name: 'fake',
  confines: true,
  enforcement: 'full',
  mode: 'workspace-write',
  wrap: (command) =>
    Effect.succeed({
      argv: ['sandbox-helper', '--', ...command.argv],
      cwd: command.cwd,
      mode: 'workspace-write',
      denialSignatures: ['denied'],
    }),
})

const failureMessage = (result: { readonly _tag: string; readonly failure?: unknown }): string =>
  result._tag === 'Failure'
    ? String((result.failure as { message?: string }).message)
    : 'no failure'

describe('job_start confinement', () => {
  test('runs the command through the sandbox instead of a bare shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-job-start-'))
    const inside = join(root, 'src')
    await mkdir(inside)
    try {
      const launches: Array<RecordedLaunch> = []
      const tool = makeJobStartTool(recordingJobs(launches), confiningSandbox())
      const value = await Effect.runPromise(
        tool.execute(
          { command: 'echo confined', cwd: 'src' },
          { sessionId: 's1', cwd: root, callId: 'c1' },
        ),
      )
      expect(value).toEqual({ id: 'job-aabbccdd', command: 'echo confined' })
      expect(launches).toEqual([
        {
          command: 'echo confined',
          cwd: inside,
          argv: ['sandbox-helper', '--', 'bash', '-c', 'echo confined'],
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses a directory outside the workspace and one reached through a link', async () => {
    const base = await mkdtemp(join(tmpdir(), 'jozo-harness-job-start-'))
    const root = join(base, 'work')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await symlink(outside, join(root, 'out'))
    try {
      const launches: Array<RecordedLaunch> = []
      const tool = makeJobStartTool(recordingJobs(launches), confiningSandbox())
      const context = { sessionId: 's1', cwd: root, callId: 'c1' }
      const escaped = await Effect.runPromise(
        Effect.result(tool.execute({ command: 'echo out', cwd: outside }, context)),
      )
      const linked = await Effect.runPromise(
        Effect.result(tool.execute({ command: 'echo out', cwd: 'out' }, context)),
      )
      expect(failureMessage(escaped)).toContain('escapes the workspace')
      expect(failureMessage(linked)).toContain('goes through a link')
      expect(launches).toEqual([])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('a run with no sandbox still starts the shell', async () => {
    const launches: Array<RecordedLaunch> = []
    const tool = makeJobStartTool(recordingJobs(launches), noneSandbox)
    const value = await Effect.runPromise(
      tool.execute({ command: 'echo plain' }, { sessionId: 's1', cwd: '/tmp', callId: 'c1' }),
    )
    expect(value.command).toBe('echo plain')
    expect(launches).toEqual([{ command: 'echo plain', cwd: '/tmp' }])
  })
})
