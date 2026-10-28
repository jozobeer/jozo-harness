import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { stat, writeFile } from 'node:fs/promises'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import type { ToolError } from '@jozo-harness/tools'
import {
  captureCommand,
  makeScreenCaptureTool,
  type CaptureHost,
  type ScreenCaptureValue,
} from '../src/index.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const hostOf = (
  platform: NodeJS.Platform,
  programs: ReadonlyArray<string>,
  run: CaptureHost['run'] = async () => ({ exitCode: 0, stderr: '' }),
): CaptureHost => ({
  platform,
  hasProgram: (program) => programs.includes(program),
  run,
})

/** A host whose run writes the image at the path the command names, as screencapture would. */
const writingHost = (platform: NodeJS.Platform, programs: ReadonlyArray<string>) =>
  hostOf(platform, programs, async (command) => {
    const path = command.argv[command.argv.length - 1] ?? ''
    await writeFile(path, PNG)
    return { exitCode: 0, stderr: '' }
  })

interface CaptureOutcome {
  readonly value: ScreenCaptureValue | undefined
  readonly error: ToolError | undefined
}

const capture = (
  args: { display?: number },
  host: CaptureHost,
  sandbox: SandboxShape = noneSandbox,
  images?: 'base64' | 'none',
): Promise<CaptureOutcome> =>
  Effect.runPromise(
    Effect.match(
      makeScreenCaptureTool(sandbox, host).execute(args, {
        sessionId: 's1',
        cwd: '/work',
        callId: 'c1',
        ...(images === undefined ? {} : { images }),
      }),
      {
        onFailure: (error) => ({ value: undefined, error }),
        onSuccess: (value) => ({ value, error: undefined }),
      },
    ),
  )

describe('captureCommand', () => {
  test('captures the whole screen on macOS with the png type', () => {
    expect(captureCommand('darwin', '/tmp/shot.png', undefined, () => false)).toEqual([
      'screencapture',
      '-x',
      '-t',
      'png',
      '/tmp/shot.png',
    ])
  })

  test('names the display on macOS when the call asks for one', () => {
    expect(captureCommand('darwin', '/tmp/shot.png', 2, () => false)).toEqual([
      'screencapture',
      '-x',
      '-t',
      'png',
      '-D',
      '2',
      '/tmp/shot.png',
    ])
  })

  test('prefers grim on Linux and falls back to ImageMagick import', () => {
    const both = (program: string) => program === 'grim' || program === 'import'

    expect(captureCommand('linux', '/tmp/shot.png', undefined, both)).toEqual([
      'grim',
      '/tmp/shot.png',
    ])
    expect(
      captureCommand('linux', '/tmp/shot.png', undefined, (program) => program === 'import'),
    ).toEqual(['import', '-window', 'root', '/tmp/shot.png'])
  })

  test('has no command where neither capture program is installed', () => {
    expect(captureCommand('linux', '/tmp/shot.png', undefined, () => false)).toBeUndefined()
    expect(captureCommand('win32', '/tmp/shot.png', undefined, () => true)).toBeUndefined()
  })
})

describe('screen_capture tool', () => {
  test('returns the captured png as base64 for an image-capable route', async () => {
    const { value, error } = await capture({}, writingHost('darwin', []))

    expect(error).toBeUndefined()
    expect(value).toEqual({
      mediaType: 'image/png',
      bytes: PNG.byteLength,
      data: PNG.toString('base64'),
    })
  })

  test('renders the capture as an image block the model can see', async () => {
    const tool = makeScreenCaptureTool(noneSandbox, writingHost('darwin', []))
    const result = await Effect.runPromise(
      Effect.match(
        tool.execute({}, { sessionId: 's1', cwd: '/work', callId: 'c1', images: 'base64' }),
        {
          onFailure: (error) => ({ value: undefined, error }),
          onSuccess: (value) => ({ value, error: undefined }),
        },
      ),
    )
    if (result.value === undefined) throw new Error('capture failed')

    expect(tool.output.render({}, result.value)).toEqual([
      { type: 'image', mediaType: 'image/png', data: PNG.toString('base64'), name: 'screen.png' },
    ])
  })

  test('leaves no screenshot behind in the temp directory', async () => {
    let shot = ''
    const host = hostOf('darwin', [], async (command) => {
      shot = command.argv[command.argv.length - 1] ?? ''
      await writeFile(shot, PNG)
      return { exitCode: 0, stderr: '' }
    })

    const { value } = await capture({}, host)

    expect(value).toBeDefined()
    await expect(stat(shot)).rejects.toThrow()
  })

  test('refuses a negative display', async () => {
    const { error } = await capture({ display: -1 }, writingHost('darwin', []))

    expect(error?.code).toBe('invalid-arguments')
  })

  test('says why it is unavailable where no capture program is installed', async () => {
    let ran = 0
    const host = hostOf('linux', [], async () => {
      ran += 1
      return { exitCode: 0, stderr: '' }
    })

    const { error } = await capture({}, host)

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('grim')
    expect(error?.message).toContain('import')
    expect(ran).toBe(0)
  })

  test('wraps the capture command with the sandbox before running it', async () => {
    const seen: { argv?: ReadonlyArray<string>; cwd?: string } = {}
    const sandbox: SandboxShape = {
      ...noneSandbox,
      name: 'recording',
      confines: true,
      mode: 'workspace-write',
      wrap: (command) =>
        Effect.sync(() => {
          seen.argv = command.argv
          seen.cwd = command.cwd
          return {
            argv: ['sh', '-c', 'exit 1'],
            cwd: command.cwd,
            mode: 'workspace-write',
            denialSignatures: [],
          }
        }),
    }
    const host = hostOf('darwin', [], async () => ({
      exitCode: 1,
      stderr: 'screencapture: screen recording is not allowed',
    }))

    const { value, error } = await capture({}, host, sandbox)

    expect(seen.cwd).toBe('/work')
    expect(seen.argv?.slice(0, 4)).toEqual(['screencapture', '-x', '-t', 'png'])
    expect(value).toBeUndefined()
    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('screen recording is not allowed')
  })

  test('reports a capture that wrote no image as unavailable', async () => {
    const { error } = await capture({}, hostOf('darwin', []))

    expect(error?.code).toBe('unavailable')
  })

  test('refuses a route that cannot carry the image', async () => {
    let ran = 0
    const host = hostOf('darwin', [], async () => {
      ran += 1
      return { exitCode: 0, stderr: '' }
    })

    const { error } = await capture({}, host, noneSandbox, 'none')

    expect(error?.code).toBe('unavailable')
    expect(ran).toBe(0)
  })
})
