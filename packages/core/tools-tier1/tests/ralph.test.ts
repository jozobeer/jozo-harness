import type { Agent, AgentsShape, CreateAgentOptions } from '@jozo-harness/agent'
import { Effect, Fiber } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  RALPH_HANDOFF_BYTES,
  makeRalphTool,
  parseRalphReport,
  type RalphReport,
} from '../src/index.ts'

const complete = (overrides: Partial<RalphReport> = {}): string =>
  JSON.stringify({
    status: 'complete',
    summary: 'the work is done',
    evidence: ['the test passed'],
    nextSteps: [],
    ...overrides,
  })

interface FakeChild {
  readonly id: string
  readonly followups: Array<string>
  readonly cancels: Array<string>
  readonly answer: string
}

const fakeAgents = (
  answers: ReadonlyArray<string>,
  settings: { readonly idleForever?: boolean } = {},
): {
  readonly agents: AgentsShape
  readonly created: Array<CreateAgentOptions>
  readonly children: Array<FakeChild>
} => {
  const created: Array<CreateAgentOptions> = []
  const children: Array<FakeChild> = []
  let counter = 0
  const agents: AgentsShape = {
    create: (createOptions) =>
      Effect.sync(() => {
        counter += 1
        const child: FakeChild = {
          id: 'child-' + String(counter),
          followups: [],
          cancels: [],
          answer: answers[counter - 1] ?? '',
        }
        created.push(createOptions)
        children.push(child)
        return {
          id: child.id,
          session: {
            events: () => [
              {
                seq: 1,
                time: 0,
                type: 'assistant/message',
                data: { content: [{ type: 'text', text: child.answer }] },
              },
            ],
          },
          followup: (message: { text: string }) =>
            Effect.sync(() => {
              child.followups.push(message.text)
            }),
          whenIdle: settings.idleForever === true ? Effect.never : Effect.void,
          cancel: (cause: string) =>
            Effect.sync(() => {
              child.cancels.push(cause)
            }),
        } as unknown as Agent
      }),
    get: () => undefined,
    list: () => [],
    childrenOf: () => [],
    dispose: () => Effect.void,
    disposeAll: () => Effect.void,
  }
  return { agents, created, children }
}

const context = (sessionId = 'parent') => ({ sessionId, cwd: '/work', callId: 'c1' })

const run = (tool: ReturnType<typeof makeRalphTool>, sessionId = 'parent') =>
  Effect.runPromise(tool.execute({ objective: 'ship the feature' }, context(sessionId)))

const textOf = (blocks: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string =>
  blocks
    .flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
    .join('')

describe('parseRalphReport', () => {
  test('reads a complete report and its evidence', () => {
    const parsed = parseRalphReport(complete())

    expect(parsed.kind).toBe('report')
    if (parsed.kind !== 'report') return
    expect(parsed.report).toEqual({
      status: 'complete',
      summary: 'the work is done',
      evidence: ['the test passed'],
      nextSteps: [],
    })
  })

  test('continue needs next steps and cannot carry a blocker', () => {
    const missing = parseRalphReport(
      JSON.stringify({ status: 'continue', summary: 'more', evidence: [], nextSteps: [] }),
    )
    const blocked = parseRalphReport(
      JSON.stringify({
        status: 'continue',
        summary: 'more',
        evidence: [],
        nextSteps: ['go on'],
        blocker: 'stuck',
      }),
    )

    expect(missing.kind).toBe('invalid')
    expect(blocked.kind === 'invalid' ? blocked.reason : '').toContain('blocker')
  })

  test('complete needs evidence and no next steps', () => {
    const withoutEvidence = parseRalphReport(complete({ evidence: [] }))
    const withNext = parseRalphReport(complete({ nextSteps: ['carry on'] }))

    expect(withoutEvidence.kind === 'invalid' ? withoutEvidence.reason : '').toContain('evidence')
    expect(withNext.kind === 'invalid' ? withNext.reason : '').toContain('next steps')
  })

  test('blocked needs a non-empty blocker', () => {
    const missing = parseRalphReport(
      JSON.stringify({ status: 'blocked', summary: 'stuck', evidence: [], nextSteps: [] }),
    )
    const empty = parseRalphReport(
      JSON.stringify({
        status: 'blocked',
        summary: 'stuck',
        evidence: [],
        nextSteps: [],
        blocker: '',
      }),
    )

    expect(missing.kind === 'invalid' ? missing.reason : '').toContain('blocker')
    expect(empty.kind === 'invalid' ? empty.reason : '').toContain('blocker')
  })

  test('refuses text that is not a report', () => {
    const notJson = parseRalphReport('done!')
    const emptySummary = parseRalphReport(complete({ summary: '' }))
    const blankEvidence = parseRalphReport(complete({ evidence: [''] }))
    const badStatus = parseRalphReport(complete({ status: 'done' as RalphReport['status'] }))

    expect(notJson.kind === 'invalid' ? notJson.reason : '').toContain('JSON')
    expect(emptySummary.kind === 'invalid' ? emptySummary.reason : '').toContain('summary')
    expect(blankEvidence.kind === 'invalid' ? blankEvidence.reason : '').toContain('evidence')
    expect(badStatus.kind === 'invalid' ? badStatus.reason : '').toContain('status')
  })
})

describe('the ralph tool', () => {
  test('runs one round in a fresh child and returns the structured report', async () => {
    const fake = fakeAgents([complete()])
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })

    const outcome = await run(tool)

    expect(outcome).toEqual({
      status: 'complete',
      rounds: 1,
      report: {
        status: 'complete',
        summary: 'the work is done',
        evidence: ['the test passed'],
        nextSteps: [],
      },
    })
    expect(fake.created[0]).toMatchObject({
      cwd: '/work',
      parent: 'parent',
      seed: [],
      options: { route: 'stub/model' },
    })
    expect(fake.children[0]?.followups[0]).toContain('ship the feature')
    expect(fake.children[0]?.followups[0]).toContain('Return only a JSON object')
    expect(textOf(tool.output.render({ objective: 'ship the feature' }, outcome))).toContain(
      'not a verified pass',
    )
  })

  test('a continue report becomes budget-limited at the round budget', async () => {
    const fake = fakeAgents([
      JSON.stringify({
        status: 'continue',
        summary: 'more to do',
        evidence: [],
        nextSteps: ['finish it'],
      }),
    ])
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })

    const outcome = await Effect.runPromise(
      tool.execute({ objective: 'ship it', maxRounds: 1 }, context()),
    )

    expect(outcome.status).toBe('budget-limited')
    expect(outcome.rounds).toBe(1)
    expect(outcome.report?.nextSteps).toEqual(['finish it'])
    expect(textOf(tool.output.render({ objective: 'ship it', maxRounds: 1 }, outcome))).toContain(
      'budget',
    )
  })

  test('a blocked report ends the run as the worker reported it', async () => {
    const fake = fakeAgents([
      JSON.stringify({
        status: 'blocked',
        summary: 'the repository is missing',
        evidence: [],
        nextSteps: [],
        blocker: 'no repository at the expected path',
      }),
    ])
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })

    const outcome = await Effect.runPromise(
      tool.execute({ objective: 'ship it', maxRounds: 3 }, context()),
    )

    expect(outcome.status).toBe('blocked')
    expect(outcome.report?.blocker).toBe('no repository at the expected path')
    expect(fake.children).toHaveLength(1)
  })

  test('an unreadable answer stops the round as failed', async () => {
    const fake = fakeAgents(['I did the work'])
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })

    const outcome = await run(tool)

    expect(outcome.status).toBe('round-failed')
    expect(outcome.rounds).toBe(1)
    expect(outcome.report).toBeNull()
    expect(outcome.error).toContain('not JSON')
    expect(textOf(tool.output.render({ objective: 'ship it' }, outcome))).toContain('round 1')
  })

  test('a child that cannot start ends the round as failed', async () => {
    const fake = fakeAgents([])
    const agents = {
      ...fake.agents,
      create: () => Effect.fail({ code: 'init', message: 'no child' } as never),
    }
    const tool = makeRalphTool({ agents, route: 'stub/model' })

    const outcome = await run(tool)

    expect(outcome.status).toBe('round-failed')
    expect(outcome.error).toBe('cannot start a child agent')
    expect(fake.created).toEqual([])
  })

  test('an empty answer ends the round as failed', async () => {
    const fake = fakeAgents([''])
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })

    const outcome = await run(tool)

    expect(outcome.status).toBe('round-failed')
    expect(outcome.error).toBe('the child answered with nothing')
  })

  test('a round budget below one is refused before a child starts', async () => {
    const fake = fakeAgents([complete()])
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })

    const error = await Effect.runPromise(
      tool.execute({ objective: 'ship it', maxRounds: 0 }, context()).pipe(Effect.flip),
    )

    expect(error.message).toContain('maxRounds')
    expect(fake.created).toEqual([])
  })

  test('a ralph worker cannot call ralph again', async () => {
    const fake = fakeAgents([complete()])
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })
    await run(tool)

    const error = await Effect.runPromise(
      tool.execute({ objective: 'recurse' }, context('child-1')).pipe(Effect.flip),
    )

    expect(error.message).toContain('ralph cannot run inside a ralph worker')
    expect(fake.children).toHaveLength(1)
  })

  test('the previous handoff is clipped before the next round reads it', async () => {
    const huge = 'x'.repeat(RALPH_HANDOFF_BYTES * 2)
    const fake = fakeAgents([
      JSON.stringify({
        status: 'continue',
        summary: huge,
        evidence: [],
        nextSteps: ['keep going'],
      }),
      complete(),
    ])
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })

    await Effect.runPromise(tool.execute({ objective: 'ship it', maxRounds: 2 }, context()))

    const second = fake.children[1]?.followups[0] ?? ''
    expect(second).toContain('[handoff truncated after ' + String(RALPH_HANDOFF_BYTES) + ' bytes]')
    expect(Buffer.byteLength(second, 'utf8')).toBeLessThan(RALPH_HANDOFF_BYTES + 2_000)
  })

  test('an interrupted call cancels the round it started', async () => {
    const fake = fakeAgents([complete()], { idleForever: true })
    const tool = makeRalphTool({ agents: fake.agents, route: 'stub/model' })
    const fiber = Effect.runFork(tool.execute({ objective: 'stay busy' }, context()))

    for (let attempt = 0; attempt < 100 && fake.children.length === 0; attempt += 1) {
      await Effect.runPromise(Effect.sleep('2 millis'))
    }
    expect(fake.children).toHaveLength(1)
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(fake.children[0]?.cancels).toEqual(['parent-cancelled'])
  })
})
