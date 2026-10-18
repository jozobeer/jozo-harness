import { describe, expect, test } from 'vitest'
import {
  TERMINAL_PATH,
  terminalFrameOf,
  terminalInputOf,
  terminalSessionOf,
  terminalSocketAt,
  type TerminalFrame,
} from '../src/shared/terminal.ts'
import { openShell, shellOf } from '../src/server/terminal.ts'
import { makeStubShell } from './stub-shell.ts'

/** Waits for what the terminal reached, or fails saying what never came. */
const until = (wanted: () => boolean, what: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let attempts = 0
    const tick = (): void => {
      if (wanted()) {
        resolve()
        return
      }
      attempts += 1
      if (attempts > 200) {
        reject(new Error('the terminal never ' + what))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })

const said = (frames: ReadonlyArray<TerminalFrame>, data: string): boolean =>
  frames.some((frame) => frame.type === 'output' && frame.data === data)

describe('the terminal wire', () => {
  test('reads the frames the shell side sends and ignores what it cannot', () => {
    expect(terminalFrameOf('{"type":"output","stream":"stdout","data":"hi\\n"}')).toEqual({
      type: 'output',
      stream: 'stdout',
      data: 'hi\n',
    })
    expect(terminalFrameOf('{"type":"exit","code":3}')).toEqual({ type: 'exit', code: 3 })
    expect(terminalFrameOf('not json')).toBeUndefined()
    expect(terminalFrameOf('{"type":"output","stream":"tty","data":"hi"}')).toBeUndefined()
    expect(terminalFrameOf('{"type":"exit","code":"3"}')).toBeUndefined()
    expect(terminalFrameOf('null')).toBeUndefined()
  })

  test('reads the frames the page side sends and ignores what it cannot', () => {
    expect(terminalInputOf('{"type":"input","data":"pwd\\n"}')).toEqual({
      type: 'input',
      data: 'pwd\n',
    })
    expect(terminalInputOf('{"type":"close"}')).toEqual({ type: 'close' })
    expect(terminalInputOf('not json')).toBeUndefined()
    expect(terminalInputOf('{"type":"input"}')).toBeUndefined()
    expect(terminalInputOf('[]')).toBeUndefined()
  })

  test('names the session a terminal url carries, and points one at its socket', () => {
    expect(TERMINAL_PATH).toBe('/terminal')
    expect(terminalSessionOf('/terminal?session=a&token=t')).toBe('a')
    expect(terminalSessionOf('/terminal')).toBeUndefined()
    expect(terminalSessionOf('/terminal?session=')).toBeUndefined()
    expect(terminalSocketAt('ws://127.0.0.1:3000/ui?token=t', 'a')).toBe(
      'ws://127.0.0.1:3000/terminal?token=t&session=a',
    )
  })

  test('takes the shell the environment names, and a POSIX one when it names none', () => {
    expect(shellOf({ SHELL: '/bin/zsh' })).toBe('/bin/zsh')
    expect(shellOf({})).toBe('/bin/sh')
    expect(shellOf({ SHELL: '' })).toBe('/bin/sh')
  })
})

describe('the shell behind the terminal', () => {
  test('carries stdout, stderr, a line of input, and the exit code', async () => {
    const stub = makeStubShell()
    const frames: Array<TerminalFrame> = []
    const session = openShell('/work', (frame) => frames.push(frame), {
      spawn: () => stub.child,
      shell: '/bin/sh',
    })

    stub.out('hello\n')
    await until(() => said(frames, 'hello\n'), 'showed stdout')
    stub.err('oops\n')
    await until(() => said(frames, 'oops\n'), 'showed stderr')

    // A frame this side does not know is dropped rather than written to the shell.
    session.message('not json')
    session.message(JSON.stringify({ type: 'input', data: 'echo hi\n' }))
    expect(stub.writes).toEqual(['echo hi\n'])

    stub.finish(3)
    await until(
      () => frames.some((frame) => frame.type === 'exit' && frame.code === 3),
      'said the exit code',
    )
    session.close()
    expect(stub.kills()).toBe(1)
  })

  test('closing stops the shell, and nothing goes either way after it', async () => {
    const stub = makeStubShell()
    const frames: Array<TerminalFrame> = []
    const session = openShell('/work', (frame) => frames.push(frame), {
      spawn: () => stub.child,
      shell: '/bin/sh',
    })
    stub.out('before\n')
    await until(() => said(frames, 'before\n'), 'showed the first line')

    session.message(JSON.stringify({ type: 'close' }))
    expect(stub.kills()).toBe(1)

    session.message(JSON.stringify({ type: 'input', data: 'after\n' }))
    expect(stub.writes).toEqual([])
    stub.out('late\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(said(frames, 'late\n')).toBe(false)

    session.close()
    // Closing twice is the same as closing once.
    expect(stub.kills()).toBe(1)
  })
})
