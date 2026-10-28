import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  APPROVAL_ANSWER,
  makeAsk,
  noneSandbox,
  SandboxError,
  type AskRequested,
  type AskShape,
  type SandboxShape,
} from '@jozo-harness/safety'
import type { ToolError, ToolRunContext } from '@jozo-harness/tools'
import {
  computerUseTools,
  makeComputerClickTool,
  makeComputerKeyTool,
  makeComputerTypeTool,
  tier1Tools,
  type ComputerUseValue,
  type ScreenHost,
} from '../src/index.ts'

const context: ToolRunContext = { sessionId: 's1', cwd: '/work', callId: 'call-1' }

/** The human answering whatever was asked, and a record of every question. */
const answering = (answer: string, asked: Array<AskRequested> = []): AskShape =>
  ({
    ask: (request: AskRequested) => {
      asked.push(request)
      return Effect.succeed(answer)
    },
  }) as unknown as AskShape

interface RunRecord {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
}

const hostOf = (
  platform: NodeJS.Platform,
  programs: ReadonlyArray<string>,
  run: ScreenHost['run'] = async () => ({ exitCode: 0, stderr: '' }),
): ScreenHost => ({
  platform,
  hasProgram: (program) => programs.includes(program),
  run,
})

/** A host that records the argv of every command it was asked to run. */
const recordingHost = (
  platform: NodeJS.Platform,
  programs: ReadonlyArray<string>,
  calls: Array<RunRecord>,
  result: { readonly exitCode: number; readonly stderr: string } = {
    exitCode: 0,
    stderr: '',
  },
): ScreenHost =>
  hostOf(platform, programs, async (command) => {
    calls.push(command)
    return result
  })

interface Outcome {
  readonly value: ComputerUseValue | undefined
  readonly error: ToolError | undefined
}

const run = (
  tool: {
    execute: (args: any, context: ToolRunContext) => Effect.Effect<ComputerUseValue, ToolError>
  },
  args: unknown,
): Promise<Outcome> =>
  Effect.runPromise(
    Effect.match(tool.execute(args, context), {
      onFailure: (error) => ({ value: undefined, error }),
      onSuccess: (value) => ({ value, error: undefined }),
    }),
  )

const darwin = ['osascript']

describe('computer_click', () => {
  test('clicks the point through osascript after the human approves', async () => {
    const calls: Array<RunRecord> = []
    const { value, error } = await run(
      makeComputerClickTool(
        noneSandbox,
        answering(APPROVAL_ANSWER),
        recordingHost('darwin', darwin, calls),
      ),
      { x: 120, y: 340 },
    )

    expect(error).toBeUndefined()
    expect(value).toEqual({
      action: 'click',
      target: { x: 120, y: 340 },
      exitCode: 0,
      stderr: 'no reason given',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toContain('tell application "System Events" to click at {px, py}')
    expect(calls[0]?.argv.slice(-2)).toEqual(['120', '340'])
  })

  test('refuses a click before the screen is touched when the human says no', async () => {
    const calls: Array<RunRecord> = []
    const asked: Array<AskRequested> = []
    const { value, error } = await run(
      makeComputerClickTool(
        noneSandbox,
        answering('deny', asked),
        recordingHost('darwin', darwin, calls),
      ),
      { x: 12, y: 34 },
    )

    expect(value).toBeUndefined()
    expect(error?.code).toBe('denied')
    expect(error?.message).toContain('(12, 34)')
    expect(calls).toEqual([])
    expect(asked).toHaveLength(1)
    expect(asked[0]?.options).toEqual([APPROVAL_ANSWER, 'deny'])
  })

  test('asks before it runs, and an unanswered question stops the click', async () => {
    const calls: Array<RunRecord> = []
    const ask = await Effect.runPromise(makeAsk())
    const { error } = await run(
      makeComputerClickTool(noneSandbox, ask, recordingHost('darwin', darwin, calls)),
      { x: 1, y: 2 },
    )

    expect(error?.code).toBe('execution')
    expect(calls).toEqual([])
  })

  test('reports unavailable on a platform that cannot control the screen', async () => {
    const calls: Array<RunRecord> = []
    const asked: Array<AskRequested> = []
    const { error } = await run(
      makeComputerClickTool(
        noneSandbox,
        answering(APPROVAL_ANSWER, asked),
        recordingHost('linux', ['osascript'], calls),
      ),
      { x: 1, y: 2 },
    )

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('linux')
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  test('reports unavailable when macOS has no osascript on PATH', async () => {
    const { error } = await run(
      makeComputerClickTool(
        noneSandbox,
        answering(APPROVAL_ANSWER),
        recordingHost('darwin', [], []),
      ),
      { x: 1, y: 2 },
    )

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('osascript')
  })
})

describe('computer_type', () => {
  test('types the whole text and keeps it in the value with its length', async () => {
    const calls: Array<RunRecord> = []
    const text = 'héllo\nworld'
    const { value, error } = await run(
      makeComputerTypeTool(
        noneSandbox,
        answering(APPROVAL_ANSWER),
        recordingHost('darwin', darwin, calls),
      ),
      { text },
    )

    expect(error).toBeUndefined()
    expect(value?.action).toBe('type')
    expect(value?.target.text).toBe(text)
    expect(value?.target.characters).toBe(text.length)
    expect(calls[0]?.argv.at(-1)).toBe(text)
  })

  test('cuts only the text in the value when it is too long, and types all of it', async () => {
    const calls: Array<RunRecord> = []
    const text = 'x'.repeat(2_500)
    const { value } = await run(
      makeComputerTypeTool(
        noneSandbox,
        answering(APPROVAL_ANSWER),
        recordingHost('darwin', darwin, calls),
      ),
      { text },
    )

    expect(value?.target.text).toBe('x'.repeat(2_000) + '…')
    expect(value?.target.characters).toBe(2_500)
    expect(calls[0]?.argv.at(-1)).toBe(text)
  })
})

describe('computer_key', () => {
  test('presses a chord with the modifier System Events understands', async () => {
    const calls: Array<RunRecord> = []
    const { value, error } = await run(
      makeComputerKeyTool(
        noneSandbox,
        answering(APPROVAL_ANSWER),
        recordingHost('darwin', darwin, calls),
      ),
      { key: 'cmd+s' },
    )

    expect(error).toBeUndefined()
    expect(value?.target.key).toBe('cmd+s')
    expect(calls[0]?.argv).toContain(
      'tell application "System Events" to keystroke (item 1 of argv) using {command down}',
    )
    expect(calls[0]?.argv.at(-1)).toBe('s')
  })

  test('presses a named key by its key code without asking the screen first', async () => {
    const calls: Array<RunRecord> = []
    const { error } = await run(
      makeComputerKeyTool(
        noneSandbox,
        answering(APPROVAL_ANSWER),
        recordingHost('darwin', darwin, calls),
      ),
      { key: 'return' },
    )

    expect(error).toBeUndefined()
    expect(calls[0]?.argv).toContain('tell application "System Events" to key code 36')
  })

  test('refuses a key name it cannot map before asking or running', async () => {
    const calls: Array<RunRecord> = []
    const asked: Array<AskRequested> = []
    const { error } = await run(
      makeComputerKeyTool(
        noneSandbox,
        answering(APPROVAL_ANSWER, asked),
        recordingHost('darwin', darwin, calls),
      ),
      { key: 'cmd+' },
    )

    expect(error?.code).toBe('invalid-arguments')
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  test('keeps the exit code and a short stderr in the value when the press fails', async () => {
    const calls: Array<RunRecord> = []
    const { value, error } = await run(
      makeComputerKeyTool(
        noneSandbox,
        answering(APPROVAL_ANSWER),
        recordingHost('darwin', darwin, calls, {
          exitCode: 1,
          stderr: 'Accessibility permission is not granted. '.repeat(20),
        }),
      ),
      { key: 'escape' },
    )

    expect(error).toBeUndefined()
    expect(value?.exitCode).toBe(1)
    expect(value?.stderr).toHaveLength(501)
    expect(value?.stderr.endsWith('…')).toBe(true)
  })
})

describe('computer use row', () => {
  test('adds the three screen tools only with the computer-use row, never to the default list', async () => {
    const ask = await Effect.runPromise(makeAsk())
    const host = hostOf('darwin', darwin)

    expect(computerUseTools(noneSandbox, ask, host).map((tool) => tool.name)).toEqual([
      'computer_click',
      'computer_type',
      'computer_key',
    ])
    expect(tier1Tools(ask).map((tool) => tool.name)).not.toContain('computer_click')
  })

  test('does not start the command when the sandbox refuses it', async () => {
    const calls: Array<RunRecord> = []
    const refusing: SandboxShape = {
      ...noneSandbox,
      mode: 'read-only',
      wrap: () => Effect.fail(new SandboxError({ message: 'no child processes in this run' })),
    }
    const { error } = await run(
      makeComputerClickTool(
        refusing,
        answering(APPROVAL_ANSWER),
        recordingHost('darwin', darwin, calls),
      ),
      { x: 1, y: 2 },
    )

    expect(error?.code).toBe('unavailable')
    expect(calls).toEqual([])
  })
})
