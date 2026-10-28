import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolExecution,
  type ToolRunContext,
} from '@jozo-harness/tools'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  autoReviewGuard,
  makeAutoReview,
  modelAutoReview,
  parseAutoReviewAnswer,
  type AutoReviewDecision,
  type AutoReviewRequest,
  type AutoReviewShape,
} from '../src/index.ts'
import { modeOf } from '../src/index.ts'

const request: AutoReviewRequest = {
  callId: 'c1',
  tool: 'write',
  arguments: '{"path":"notes.md"}',
  cwd: '/work',
}

const execution = (tool: string, nested = false): ToolExecution => {
  const context: ToolRunContext = {
    sessionId: 's1',
    cwd: '/work',
    callId: 'c1',
    ...(nested ? { nested: true as const } : {}),
  }
  return { callId: 'c1', tool, arguments: '{"text":"x"}', args: {}, context }
}

const fakeReview = (
  decision: AutoReviewDecision,
): AutoReviewShape & { readonly seen: ReadonlyArray<AutoReviewRequest> } => {
  const seen: Array<AutoReviewRequest> = []
  const shape: AutoReviewShape = {
    serve: () => Effect.void,
    stopServing: () => Effect.void,
    served: () => true,
    review: (one) =>
      Effect.sync(() => {
        seen.push(one)
        return decision
      }),
  }
  return { ...shape, seen }
}

const ask = (shape: AutoReviewShape, exec: ToolExecution) =>
  Effect.runPromise(shape.review({ ...request, callId: exec.callId, tool: exec.tool }))

const check = (options: Parameters<typeof autoReviewGuard>[0], exec: ToolExecution) =>
  Effect.runPromise(autoReviewGuard(options).check(exec))

describe('the auto preset', () => {
  test('keeps the workspace-write sandbox rather than widening it', () => {
    expect(modeOf('auto')).toBe('workspace-write')
  })
})

describe('parseAutoReviewAnswer', () => {
  test('allows only an explicit ALLOW line', () => {
    expect(parseAutoReviewAnswer('ALLOW')).toEqual({ kind: 'allow' })
    expect(parseAutoReviewAnswer('  allow  ')).toEqual({ kind: 'allow' })
  })

  test('keeps the reason of a DENY answer', () => {
    expect(parseAutoReviewAnswer('DENY: it deletes the repository')).toEqual({
      kind: 'deny',
      reason: 'it deletes the repository',
    })
    expect(parseAutoReviewAnswer('deny')).toEqual({
      kind: 'deny',
      reason: 'the reviewer denied the call',
    })
  })

  test('denies an answer it cannot read', () => {
    expect(parseAutoReviewAnswer('maybe?')).toEqual({
      kind: 'deny',
      reason: 'the reviewer did not answer ALLOW or DENY',
    })
  })
})

describe('modelAutoReview', () => {
  test('asks the model once and returns its verdict', async () => {
    const prompts: Array<string> = []
    const review = modelAutoReview((prompt) =>
      Effect.sync(() => {
        prompts.push(prompt)
        return 'ALLOW'
      }),
    )

    const decision = await Effect.runPromise(review(request))

    expect(decision).toEqual({ kind: 'allow' })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('tool: write')
    expect(prompts[0]).toContain('notes.md')
  })

  test('denies when the model fails', async () => {
    const review = modelAutoReview(() => Effect.fail(new Error('no answer')))

    const decision = await Effect.runPromise(review(request))

    expect(decision).toEqual({
      kind: 'deny',
      reason: 'the reviewer did not answer before the deadline',
    })
  })

  test('denies when the model misses the deadline', async () => {
    const review = modelAutoReview(() => Effect.never, 1)

    const decision = await Effect.runPromise(review(request))

    expect(decision.kind).toBe('deny')
  })
})

describe('the review holder', () => {
  test('denies until a reviewer is served, and after it leaves', async () => {
    const holder = await Effect.runPromise(makeAutoReview())
    const absent = await ask(holder, execution('write'))
    await Effect.runPromise(holder.serve(fakeReview({ kind: 'allow' }).review))
    const served = await ask(holder, execution('write'))
    await Effect.runPromise(holder.stopServing())
    const stopped = await ask(holder, execution('write'))

    expect(holder.served()).toBe(false)
    expect(absent).toEqual({ kind: 'deny', reason: 'no auto reviewer is installed' })
    expect(served).toEqual({ kind: 'allow' })
    expect(stopped).toEqual({ kind: 'deny', reason: 'no auto reviewer is installed' })
  })

  test('denies when the served reviewer fails', async () => {
    const holder = await Effect.runPromise(makeAutoReview())
    await Effect.runPromise(holder.serve(() => Effect.die(new Error('the reviewer crashed'))))

    const decision = await ask(holder, execution('write'))

    expect(decision).toEqual({
      kind: 'deny',
      reason: 'the auto reviewer failed before it answered',
    })
  })
})

describe('autoReviewGuard', () => {
  test('reviews a side-effecting call and denies it', async () => {
    const review = fakeReview({ kind: 'deny', reason: 'it writes outside the workspace' })

    const decision = await check(
      { preset: () => 'auto', review, isReadOnly: () => false },
      execution('write'),
    )

    expect(decision).toEqual({ kind: 'deny', reason: 'it writes outside the workspace' })
    expect(review.seen).toHaveLength(1)
  })

  test('lets the call through when the review allows it', async () => {
    const review = fakeReview({ kind: 'allow' })

    const decision = await check(
      { preset: () => 'auto', review, isReadOnly: () => false },
      execution('write'),
    )

    expect(decision).toEqual({ kind: 'abstain' })
    expect(review.seen).toHaveLength(1)
  })

  test('does not review a read-only call', async () => {
    const review = fakeReview({ kind: 'deny', reason: 'never asked' })

    const decision = await check(
      { preset: () => 'auto', review, isReadOnly: (tool) => tool === 'read' },
      execution('read'),
    )

    expect(decision).toEqual({ kind: 'abstain' })
    expect(review.seen).toHaveLength(0)
  })

  test('does not review a call a run_code program made', async () => {
    const review = fakeReview({ kind: 'deny', reason: 'never asked' })

    const decision = await check(
      { preset: () => 'auto', review, isReadOnly: () => false },
      execution('write', true),
    )

    expect(decision).toEqual({ kind: 'abstain' })
    expect(review.seen).toHaveLength(0)
  })

  test('leaves every other preset alone', async () => {
    for (const preset of ['read-only', 'workspace-write', 'full'] as const) {
      const review = fakeReview({ kind: 'deny', reason: 'never asked' })
      const decision = await check(
        { preset: () => preset, review, isReadOnly: () => false },
        execution('write'),
      )
      expect(decision).toEqual({ kind: 'abstain' })
      expect(review.seen).toHaveLength(0)
    }
  })

  test('records the verdict without letting a failed write change it', async () => {
    const seen: Array<{ readonly decision: string; readonly sessionId: string }> = []
    const review = fakeReview({ kind: 'deny', reason: 'unsafe' })

    const denied = await check(
      {
        preset: () => 'auto',
        review,
        isReadOnly: () => false,
        record: (reviewed) => {
          seen.push(reviewed)
          return Effect.fail(new Error('the log is gone')).pipe(Effect.ignore)
        },
      },
      execution('write'),
    )
    const allowed = await check(
      { preset: () => 'auto', review: fakeReview({ kind: 'allow' }), isReadOnly: () => false },
      execution('write'),
    )

    expect(denied.kind).toBe('deny')
    expect(allowed.kind).toBe('abstain')
    expect(seen).toEqual([
      { sessionId: 's1', callId: 'c1', tool: 'write', decision: 'denied', reason: 'unsafe' },
    ])
  })
})

const alwaysRun = (
  ran: { value: boolean },
  readOnly = false,
): ToolDefinition<{}, { readonly ok: boolean }> => ({
  name: 'write',
  description: 'A tool that changes the workspace',
  ...(readOnly ? { readOnly: true } : {}),
  parameters: Schema.Struct({}),
  output: {
    schema: Schema.Struct({ ok: Schema.Boolean }),
    render: () => [{ type: 'text', text: 'ran' }],
  },
  execute: () =>
    Effect.sync(() => {
      ran.value = true
      return { ok: true }
    }),
})

const callWith = (
  preset: 'read-only' | 'workspace-write' | 'full' | 'auto',
  decision: AutoReviewDecision,
  readOnly = false,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* Tools
        const ran = { value: false }
        yield* tools.register(alwaysRun(ran, readOnly))
        const review = fakeReview(decision)
        yield* tools.guard({
          ...autoReviewGuard({ preset: () => preset, review, isReadOnly: () => readOnly }),
        })
        const outcome = yield* tools.call({
          callId: 'c1',
          tool: 'write',
          arguments: '{}',
          context: { sessionId: 's1', cwd: '/work', callId: 'c1' },
        })
        return { outcome, ran: ran.value, reviewed: review.seen.length }
      }).pipe(Effect.provide(Layer.provideMerge(toolsLayer, HooksLive))),
    ),
  )

describe('the auto review in the tool pipeline', () => {
  test('does not run a call the reviewer denied', async () => {
    const { outcome, ran, reviewed } = await callWith('auto', {
      kind: 'deny',
      reason: 'it rewrites the release notes',
    })

    expect(outcome.isError).toBe(true)
    expect(outcome.error?.code).toBe('denied')
    expect(ran).toBe(false)
    expect(reviewed).toBe(1)
  })

  test('runs a call the reviewer allowed', async () => {
    const { outcome, ran, reviewed } = await callWith('auto', { kind: 'allow' })

    expect(outcome.isError).toBe(false)
    expect(ran).toBe(true)
    expect(reviewed).toBe(1)
  })

  test('never reviews under another preset', async () => {
    for (const preset of ['read-only', 'workspace-write', 'full'] as const) {
      const { outcome, ran, reviewed } = await callWith(preset, { kind: 'deny', reason: 'no' })
      expect(outcome.isError).toBe(false)
      expect(ran).toBe(true)
      expect(reviewed).toBe(0)
    }
  })

  test('never reviews a read-only tool', async () => {
    const { outcome, ran, reviewed } = await callWith('auto', { kind: 'deny', reason: 'no' }, true)

    expect(outcome.isError).toBe(false)
    expect(ran).toBe(true)
    expect(reviewed).toBe(0)
  })
})
