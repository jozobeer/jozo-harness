import { describe, expect, test } from 'vitest'
import { clientOf, resultText, stubTransport, textTurn, toolCallTurn } from './worker-fixtures.ts'

describe('browser worker', () => {
  test('streams the turn events and resolves with the assistant answer', async () => {
    const { client, events } = clientOf(stubTransport([textTurn('Hello from the worker.')]))

    const answer = await client.prompt('say hello')

    expect(answer).toBe('Hello from the worker.')
    const types = events.map((event) => event.type)
    expect(types).toContain('assistant/message')
    expect(types.indexOf('assistant/message')).toBeGreaterThan(types.indexOf('user/message'))
    client.close()
  })

  test('runs a turn with a tool call and writes its result into the log', async () => {
    const { client, events } = clientOf(
      stubTransport([
        toolCallTurn(
          'write',
          JSON.stringify({ path: 'note.txt', content: 'hi from the worker\n' }),
        ),
        textTurn('Wrote the note.'),
      ]),
    )

    const answer = await client.prompt('write a note')

    expect(answer).toBe('Wrote the note.')
    const call = events.find((event) => event.type === 'tool/call')
    expect(call).toMatchObject({ data: { name: 'write' } })
    const result = events.find((event) => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.data.isError : true).toBe(false)
    expect(result === undefined ? '' : resultText(result)).toContain('note.txt')
    client.close()
  })

  test('keeps the workspace across prompts and drops it when the worker closes', async () => {
    const first = clientOf(
      stubTransport([
        toolCallTurn(
          'write',
          JSON.stringify({ path: 'note.txt', content: 'kept between turns\n' }),
        ),
        textTurn('Wrote it.'),
        toolCallTurn('read', JSON.stringify({ path: 'note.txt' })),
        textTurn('Read it.'),
      ]),
    )

    await first.client.prompt('write a note')
    await first.client.prompt('read the note')
    const seen = first.events.find(
      (event) => event.type === 'tool/result' && resultText(event).includes('kept between turns'),
    )
    expect(seen).toBeDefined()
    first.client.close()
    await first.whenClosed()

    const second = clientOf(
      stubTransport([
        toolCallTurn('read', JSON.stringify({ path: 'note.txt' })),
        textTurn('Gone.'),
      ]),
    )
    await second.client.prompt('read the note')
    const missing = second.events.find((event) => event.type === 'tool/result')
    expect(
      missing !== undefined && missing.type === 'tool/result' ? missing.data.isError : false,
    ).toBe(true)
    second.client.close()
  })

  test('reports a failed turn as an error instead of a done', async () => {
    const { client } = clientOf(async () => {
      throw new Error('the model is unreachable')
    })

    await expect(client.prompt('say hello')).rejects.toThrow('the model is unreachable')
    client.close()
  })
})
