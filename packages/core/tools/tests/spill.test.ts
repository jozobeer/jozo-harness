import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  applySpill,
  BYTES_PER_TOKEN,
  estimateTokens,
  planSpill,
  SPILL_PREVIEW_CHARS,
  SPILL_TAIL_CHARS,
  textOf,
} from '../src/index.ts'

const blocks = (text: string) => [{ type: 'text' as const, text }]

describe('estimateTokens', () => {
  test('counts four bytes as one token', () => {
    expect(BYTES_PER_TOKEN).toBe(4)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('あいうえお')).toBe(4)
  })
})

describe('planSpill', () => {
  test('keeps a result inside the token budget', () => {
    expect(planSpill(blocks('short'), 100)).toEqual({ kind: 'keep' })
  })

  test('spills a result over the budget with its head, its tail, and what it left out', () => {
    const long = 'h'.repeat(2000) + 'm'.repeat(4000) + 't'.repeat(500)
    const plan = planSpill(blocks(long), 100)

    expect(plan.kind).toBe('spill')
    if (plan.kind !== 'spill') return
    expect(plan.text).toBe(long)
    expect(plan.head).toHaveLength(SPILL_PREVIEW_CHARS)
    expect(plan.tail).toHaveLength(SPILL_TAIL_CHARS)
    expect(plan.tail.endsWith('t')).toBe(true)
    expect(plan.omittedBytes).toBe(4000)
    expect(plan.tokens).toBe(estimateTokens(long))
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
  const long = 'h'.repeat(2000) + 'm'.repeat(4000) + 't'.repeat(500)

  test('a text over the budget keeps its head, its tail, and the way to the middle', async () => {
    const written: Array<{ callId: string; text: string }> = []
    const spilled = await Effect.runPromise(
      applySpill(result(long), subject, {
        maxSpillTokens: 100,
        spill: (callId, text) =>
          Effect.sync(() => {
            written.push({ callId, text })
            return '/managed/spill/s1/c1.txt'
          }),
      }),
    )

    expect(written).toEqual([{ callId: 'c1', text: long }])
    const first = spilled.content[0]
    const notice = first?.type === 'text' ? first.text : ''
    expect(notice.startsWith('h'.repeat(SPILL_PREVIEW_CHARS))).toBe(true)
    expect(notice.endsWith('t'.repeat(SPILL_TAIL_CHARS))).toBe(true)
    expect(notice).toContain('… middle omitted (4000 bytes); read /managed/spill/s1/c1.txt')
    expect(notice).not.toContain('m'.repeat(10))
  })

  test('the middle leaves the content, not only the preview', async () => {
    const spilled = await Effect.runPromise(
      applySpill(result(long), subject, {
        maxSpillTokens: 100,
        spill: () => Effect.succeed('/managed/spill/s1/c1.txt'),
      }),
    )

    const first = spilled.content[0]
    const text = first?.type === 'text' ? first.text : ''
    expect(text).toContain('… middle omitted (4000 bytes)')
    expect(text.length).toBeLessThan(long.length)
  })

  test('an image over the budget becomes a read_image locator without its base64', async () => {
    const data = 'A'.repeat(4000)
    const image = { type: 'image' as const, mediaType: 'image/png', data, name: '/work/pic.png' }
    let received: { data: string; mediaType: string } | undefined
    const spilled = await Effect.runPromise(
      applySpill({ isError: false, content: [image] }, subject, {
        maxSpillTokens: 10,
        spillImage: (_callId, given, mediaType) =>
          Effect.sync(() => {
            received = { data: given, mediaType }
            return '/managed/spill/s1/c1.png'
          }),
      }),
    )

    expect(received).toEqual({ data, mediaType: 'image/png' })
    expect(spilled.content).toEqual([
      {
        type: 'text',
        text: '[image /managed/spill/s1/c1.png; show it again with the read_image tool]',
      },
    ])
    expect(JSON.stringify(spilled.content)).not.toContain('AAAA')
  })

  test('a small result in the same content is not written away', async () => {
    let writes = 0
    const spilled = await Effect.runPromise(
      applySpill(
        {
          isError: false,
          content: [
            ...blocks('small'),
            { type: 'image', mediaType: 'image/png', data: 'A'.repeat(40) },
          ],
        },
        subject,
        {
          maxSpillTokens: 100,
          spill: () =>
            Effect.sync(() => {
              writes += 1
              return 'x'
            }),
          spillImage: () =>
            Effect.sync(() => {
              writes += 1
              return 'x'
            }),
        },
      ),
    )
    expect(writes).toBe(0)
    expect(spilled.content).toHaveLength(2)
  })

  test('a read result is never spilled: the model rereads it instead', async () => {
    let writes = 0
    const kept = await Effect.runPromise(
      applySpill(
        result('x'.repeat(100)),
        { callId: 'c1', tool: 'read' },
        {
          maxSpillTokens: 10,
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

  test('a read_image result is never spilled: showing it again is the way back', async () => {
    let writes = 0
    const kept = await Effect.runPromise(
      applySpill(
        {
          isError: false,
          content: [{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(400) }],
        },
        { callId: 'c1', tool: 'read_image' },
        {
          maxSpillTokens: 1,
          spillImage: () =>
            Effect.sync(() => {
              writes += 1
              return 'x'
            }),
        },
      ),
    )

    expect(writes).toBe(0)
    expect(kept.content[0]?.type).toBe('image')
  })

  test('keeps a small result and never writes', async () => {
    let writes = 0
    const kept = await Effect.runPromise(
      applySpill(result('small'), subject, {
        maxSpillTokens: 100,
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
      applySpill({ ...result(long), diffs }, subject, {
        maxSpillTokens: 100,
        spill: () => Effect.succeed('/managed/spill/s1/c1.txt'),
      }),
    )

    expect(spilled.diffs).toEqual(diffs)
  })

  test('leaves an error result alone', async () => {
    const failed = await Effect.runPromise(
      applySpill({ isError: true, content: blocks('boom'.repeat(500)) }, subject, {
        maxSpillTokens: 1,
        spill: () => Effect.succeed('x'),
      }),
    )

    expect(failed.isError).toBe(true)
    expect(failed.content).toEqual(blocks('boom'.repeat(500)))
  })

  test('a write that fails leaves the content where it was', async () => {
    const failed = await Effect.runPromise(
      applySpill(result(long), subject, {
        maxSpillTokens: 100,
        spill: () => Effect.die(new Error('the disk is full')),
      }),
    )

    expect(failed.content).toEqual(blocks(long))
  })
})
