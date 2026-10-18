import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { parseArgs } from '../src/args.ts'
import { main } from '../src/bin.ts'

const io = (out: Array<string>, err: Array<string>) => ({
  stdout: (text: string) => out.push(text),
  stderr: (text: string) => err.push(text),
  cwd: '/work',
})

describe('the --subagents flag', () => {
  test('the parser takes it as a switch, not an unknown option', () => {
    const parsed = parseArgs(['--subagents', 'hi'])

    expect(parsed.errors).toEqual([])
    expect(parsed.subagents).toBe(true)
    expect(parsed.task).toBe('hi')
  })

  test('--help names it beside the other switches', async () => {
    const out: Array<string> = []
    const err: Array<string> = []
    const code = await Effect.runPromise(main(['--help'], io(out, err)))

    expect(code).toBe(0)
    expect(out.join('')).toContain('--subagents')
  })

  test('--dump-config lists it among the flags a run accepts', async () => {
    const out: Array<string> = []
    const err: Array<string> = []
    const code = await Effect.runPromise(main(['--subagents', '--dump-config'], io(out, err)))

    expect(code).toBe(0)
    expect(err).toEqual([])
    const dump = out.join('')
    expect(dump).toContain('flags (jzh --help shows how they are used):')
    expect(dump).toContain('--subagents')
  })
})
