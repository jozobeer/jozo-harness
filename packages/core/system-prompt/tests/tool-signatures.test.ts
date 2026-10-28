import { describe, expect, test } from 'vitest'
import { parameterList, signatureLine, toolSignatureText } from '../src/index.ts'

const schema = (value: unknown): Readonly<Record<string, unknown>> =>
  value as Readonly<Record<string, unknown>>

describe('tool signatures', () => {
  test('renders required and optional arguments and the result object', () => {
    const line = signatureLine({
      name: 'run_code',
      description: 'Run a program',
      parameters: schema({
        type: 'object',
        properties: {
          code: { type: 'string' },
          runtime: { enum: ['node', 'python'] },
        },
        required: ['code'],
      }),
      output: schema({
        type: 'object',
        properties: {
          output: { type: 'string' },
          truncated: { type: 'boolean' },
          toolCalls: { type: 'integer' },
        },
        required: ['output', 'truncated', 'toolCalls'],
      }),
    })

    expect(line).toBe(
      'run_code(code: string, runtime?: "node" | "python") -> ' +
        '{ output: string; truncated: boolean; toolCalls: number }',
    )
  })

  test('renders arrays, unions, and nested objects', () => {
    const list = parameterList(
      schema({
        type: 'object',
        properties: {
          roots: { type: 'array', items: { type: 'string' } },
          mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          filter: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
        required: ['roots'],
      }),
    )

    expect(list).toBe('roots: string[], mode?: string | null, filter?: { name: string }')
  })

  test('renders the definition a ref points at', () => {
    const line = signatureLine({
      name: 'todo_write',
      description: 'Write todos',
      parameters: schema({
        type: 'object',
        properties: {
          todos: { type: 'array', items: { $ref: '#/$defs/Todo' } },
        },
        required: ['todos'],
        $defs: {
          Todo: {
            type: 'object',
            properties: { content: { type: 'string' } },
            required: ['content'],
          },
        },
      }),
      output: schema({ type: 'object', properties: { count: { type: 'integer' } } }),
    })

    expect(line).toBe('todo_write(todos: { content: string }[]) -> { count?: number }')
  })

  test('no visible signatures renders no block', () => {
    expect(toolSignatureText([])).toBe('')
  })

  test('the block lists one line per tool under its heading', () => {
    const text = toolSignatureText([
      {
        name: 'echo',
        description: 'Echo',
        parameters: schema({
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        }),
        output: schema({
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        }),
      },
    ])

    expect(text.split('\n')).toEqual([
      'Tools visible in this request, with the types of their arguments and result:',
      'echo(text: string) -> { text: string }',
    ])
  })
})
