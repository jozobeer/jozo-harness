import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { applySpill, planSpill, SPILL_PREVIEW_CHARS, textOf } from '../src/index.ts'

const blocks = (text: string) => [{ type: 'text' as const, text }]

describe('planSpill', () => {
  test('keeps a result inside the limit', () => {
    expect(planSpill(blocks('short'), 100)).toEqual({ kind: 'keep' })
  })

  test('spills a result over the limit and keeps a preview', () => {
    const long = 'x'.repeat(50) + '\n' + 'y'.repeat(50)
    const plan = planSpill(blocks(long), 20, 10)

    expect(plan.kind).toBe('spill')
    if (plan.kind !== 'spill') return
    expect(plan.text).toBe(long)
    expect(plan.preview).toBe('x'.repeat(10))
    expect(plan.bytes).toBe(101)
    expect(plan.lines).toBe(2)
  })

  test('counts bytes, not characters', () => {
    const plan = planSpill(blocks('あいうえお'), 5)

    expect(plan.kind).toBe('spill')
    if (plan.kind !== 'spill') return
    expect(plan.bytes).toBe(15)
  })
})

describe('textOf', () => {
  test('joins text blocks and ignores the rest', () => {
    expect(
      textOf([
        { type: 'text', text: 'a' },
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab')
    expect(SPILL_PREVIEW_CHARS).toBe(2000)
  })
})

describe('applySpill', () => {
  const result = (text: string) => ({ isError: false, content: blocks(text) })
  const subject = { callId: 'c1', tool: 'bash' }

  test('writes a big result away and keeps a preview with the way back', async () => {
    const written: Array<{ callId: string; text: string }> = []
    const spilled = await Effect.runPromise(
      applySpill(result('x'.repeat(100)), subject, {
        maxSpillBytes: 10,
        spill: (callId, text) =>
          Effect.sync(() => {
            written.push({ callId, text })
            return '/managed/spill/s1/c1.txt'
          }),
      }),
    )

    expect(written).toEqual([{ callId: 'c1', text: 'x'.repeat(100) }])
    const first = spilled.content[0]
    const notice = first?.type === 'text' ? first.text : ''
    expect(notice).toContain('[spilled to /managed/spill/s1/c1.txt: 1 lines, 100 bytes')
    expect(notice).toContain('read')
    expect(notice).toContain('offset')
    expect(notice).toContain('x'.repeat(50))
  })

  test('a read result is never spilled: the model rereads it instead', async () => {
    let writes = 0
    const kept = await Effect.runPromise(
      applySpill(
        result('x'.repeat(100)),
        { callId: 'c1', tool: 'read' },
        {
          maxSpillBytes: 10,
          spill: () =>
            Effect.sync(() => {
              writes += 1
              return 'x'
            }),
        },
      ),
    )

    expect(writes).toBe(0)
    expect(kept.content).toEqual(blocks('x'.repeat(100)))
  })

  test('keeps a small result and never writes', async () => {
    let writes = 0
    const kept = await Effect.runPromise(
      applySpill(result('small'), subject, {
        maxSpillBytes: 100,
        spill: () =>
          Effect.sync(() => {
            writes += 1
            return 'x'
          }),
      }),
    )

    expect(kept.content).toEqual(blocks('small'))
    expect(writes).toBe(0)
  })

  test('keeps the file changes when it writes the text away', async () => {
    const diffs = [
      { path: '/work/a.txt', oldStart: 2, newStart: 2, removed: ['old'], added: ['new'] },
    ]
    const spilled = await Effect.runPromise(
      applySpill({ ...result('x'.repeat(100)), diffs }, subject, {
        maxSpillBytes: 10,
        spill: () => Effect.succeed('/managed/spill/s1/c1.txt'),
      }),
    )

    expect(spilled.diffs).toEqual(diffs)
  })

  test('leaves an error result alone', async () => {
    const failed = await Effect.runPromise(
      applySpill({ isError: true, content: blocks('boom'.repeat(50)) }, subject, {
        maxSpillBytes: 1,
        spill: () => Effect.succeed('x'),
      }),
    )

    expect(failed.isError).toBe(true)
    expect(failed.content).toEqual(blocks('boom'.repeat(50)))
  })

  test('a write that fails leaves the content where it was', async () => {
    const failed = await Effect.runPromise(
      applySpill(result('x'.repeat(100)), subject, {
        maxSpillBytes: 10,
        spill: () => Effect.die(new Error('the disk is full')),
      }),
    )

    expect(failed.content).toEqual(blocks('x'.repeat(100)))
  })
})
