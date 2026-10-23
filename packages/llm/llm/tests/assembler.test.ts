import { describe, expect, test } from 'vitest'
import { BlockAssembler } from '../src/index.ts'

const fragment = (): string => crypto.randomUUID().slice(0, 8)

describe('BlockAssembler', () => {
  test('joins consecutive text deltas into one block', () => {
    const assembler = new BlockAssembler()
    const first = fragment()
    const second = fragment()

    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, text: first })
    assembler.push({ type: 'text-delta', index: 0, text: second })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: first + second } })

    expect(assembler.snapshot().content).toEqual([{ type: 'text', text: first + second }])
  })

  test('assembles reasoning, text, and tool call blocks in index order', () => {
    const assembler = new BlockAssembler()
    const id = crypto.randomUUID()
    const args = JSON.stringify({ path: fragment() })

    assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
    assembler.push({ type: 'reasoning-delta', index: 0, text: 'think' })
    assembler.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
    assembler.push({
      type: 'tool-call-delta',
      index: 1,
      id,
      name: 'read',
      argumentsDelta: args.slice(0, 5),
    })
    assembler.push({ type: 'tool-call-delta', index: 1, id, argumentsDelta: args.slice(5) })
    assembler.push({ type: 'block-start', index: 2, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 2, text: 'done' })
    assembler.push({ type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } })
    assembler.push({ type: 'finish', kind: 'tool-calls' })

    expect(assembler.snapshot()).toEqual({
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'tool-call', id, name: 'read', arguments: args },
        { type: 'text', text: 'done' },
      ],
      usage: { inputTokens: 3, outputTokens: 5 },
      finish: 'tool-calls',
    })
  })

  test('a settled block replaces the accumulated draft', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'text-delta', index: 0, text: 'partial' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'authoritative' } })

    expect(assembler.snapshot().content).toEqual([{ type: 'text', text: 'authoritative' }])
  })

  test('an empty id on a later fragment does not clear the tool call id', () => {
    const assembler = new BlockAssembler()
    assembler.push({
      type: 'tool-call-delta',
      index: 2,
      id: 'call_1',
      name: 'echo',
      argumentsDelta: '{"text":',
    })
    assembler.push({ type: 'tool-call-delta', index: 2, id: '', argumentsDelta: '"hi"}' })

    expect(assembler.snapshot().content).toEqual([
      { type: 'tool-call', id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' },
    ])
  })

  test('fails when a tool call never receives its name', () => {
    const assembler = new BlockAssembler()
    assembler.push({
      type: 'tool-call-delta',
      index: 0,
      id: crypto.randomUUID(),
      argumentsDelta: '{}',
    })

    expect(() => assembler.snapshot()).toThrow('tool call')
  })

  test('starts empty without usage or a finish kind', () => {
    expect(new BlockAssembler().snapshot()).toEqual({
      content: [],
      usage: undefined,
      finish: undefined,
    })
  })
})
