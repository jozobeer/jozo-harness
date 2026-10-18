import { describe, expect, test } from 'vitest'
import {
  commandCandidates,
  commandTokenAt,
  completedCommand,
  movedCommandIndex,
} from '../src/ui/commands.ts'
import type { CommandView } from '../src/shared/rpc.ts'

const command = (
  name: string,
  summary: string,
  kind: 'command' | 'skill' = 'command',
): CommandView => ({
  name,
  summary,
  kind,
})

const commands: ReadonlyArray<CommandView> = [
  command('help', 'list the commands this session answers'),
  command('status', 'where this session stands'),
  command('goal', 'what this session works toward'),
  command('skill', 'load one skill before acting', 'skill'),
]

describe('the command word under the caret', () => {
  test('a slash at the start of the line opens the first word', () => {
    expect(commandTokenAt('/st', 3)).toEqual({ text: '/st', start: 0, end: 3 })
    expect(commandTokenAt('/status', 3)).toEqual({ text: '/status', start: 0, end: 7 })
  })

  test('a caret after the first word is not a command word any more', () => {
    expect(commandTokenAt('/status now', 10)).toBeUndefined()
    expect(commandTokenAt('say /status', 5)).toBeUndefined()
    expect(commandTokenAt('', 0)).toBeUndefined()
  })

  test('the caret sits inside the first line only', () => {
    expect(commandTokenAt('/st\nmore', 3)).toEqual({ text: '/st', start: 0, end: 3 })
    expect(commandTokenAt('/status\nmore', 10)).toBeUndefined()
  })
})

describe('the candidates for one command word', () => {
  test('prefix matches come before substring matches', () => {
    expect(
      commandCandidates(commands, { text: '/st', start: 0, end: 3 }).map((one) => one.name),
    ).toEqual(['status'])
    expect(
      commandCandidates(commands, { text: '/ta', start: 0, end: 3 }).map((one) => one.name),
    ).toEqual(['status'])
  })

  test('the bare slash offers everything, skills included, and keeps their order', () => {
    expect(
      commandCandidates(commands, { text: '/', start: 0, end: 1 }).map((one) => one.name),
    ).toEqual(['help', 'status', 'goal', 'skill'])
  })

  test('an empty match is an empty list', () => {
    expect(commandCandidates(commands, { text: '/zz', start: 0, end: 3 })).toEqual([])
  })
})

describe('moving the selection', () => {
  test('the arrows wrap around', () => {
    expect(movedCommandIndex(0, 1, 3)).toBe(1)
    expect(movedCommandIndex(2, 1, 3)).toBe(0)
    expect(movedCommandIndex(0, -1, 3)).toBe(2)
  })

  test('nothing to move stays at zero', () => {
    expect(movedCommandIndex(0, 1, 0)).toBe(0)
  })
})

describe('accepting one candidate', () => {
  test('the word is replaced with the name and a space for its arguments', () => {
    expect(completedCommand('/st', { text: '/st', start: 0, end: 3 }, 'status')).toEqual({
      text: '/status ',
      caret: 8,
    })
  })

  test('text after the word starts on the next line', () => {
    expect(completedCommand('/st\nnext', { text: '/st', start: 0, end: 3 }, 'status')).toEqual({
      text: '/status \nnext',
      caret: 8,
    })
  })
})
