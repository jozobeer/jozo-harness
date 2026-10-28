import { accessSync, constants, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import type { Plugin } from '@jozo-harness/kernel'
import { spawn } from '@jozo-harness/process'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const Parameters = Schema.Struct({
  display: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        'The macOS display to capture, counting from zero. Omit it to capture every display as one image. Linux ignores it.',
    }),
  ),
})

export type ScreenCaptureArgs = Schema.Schema.Type<typeof Parameters>

export interface ScreenCaptureValue {
  readonly mediaType: string
  readonly bytes: number
  /** Base64 of the png, so the value alone is enough to render the capture. */
  readonly data: string
}

/** What the tool needs from the host: which programs exist, and how a confined command runs. */
export interface CaptureHost {
  readonly platform: NodeJS.Platform
  readonly hasProgram: (program: string) => boolean
  /** Runs the sandbox-wrapped command; tests replace this so no screen is captured. */
  readonly run: (command: {
    readonly argv: ReadonlyArray<string>
    readonly cwd: string
  }) => Promise<{ readonly exitCode: number; readonly stderr: string }>
}

/** True when the program is an executable file on PATH. */
const executableOnPath = (program: string): boolean =>
  (process.env.PATH ?? '').split(delimiter).some((directory) => {
    const candidate = join(directory, program)
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The host a real run uses. A child that cannot start reads as a failed capture, not a crash. */
export const systemCaptureHost: CaptureHost = {
  platform: process.platform,
  hasProgram: executableOnPath,
  run: async (command) => {
    const child = spawn([...command.argv], { cwd: command.cwd, stdout: 'ignore', stderr: 'pipe' })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { exitCode, stderr }
  },
}

/**
 * The argv that captures the screen, before the sandbox wraps it. macOS has
 * screencapture; Linux takes grim when it is installed and ImageMagick's import
 * otherwise, because a headless host often has neither.
 */
export const captureCommand = (
  platform: NodeJS.Platform,
  path: string,
  display: number | undefined,
  hasProgram: (program: string) => boolean,
): ReadonlyArray<string> | undefined => {
  if (platform === 'darwin') {
    return [
      'screencapture',
      '-x',
      '-t',
      'png',
      ...(display === undefined ? [] : ['-D', String(display)]),
      path,
    ]
  }
  if (platform !== 'linux') return undefined
  if (hasProgram('grim')) return ['grim', path]
  if (hasProgram('import')) return ['import', '-window', 'root', path]
  return undefined
}

/** Why this host has no way to take the screen, as the model should read it. */
const noCommandMessage = (platform: NodeJS.Platform): string =>
  platform === 'linux'
    ? 'screen_capture is unavailable: Linux needs grim or ImageMagick import on PATH'
    : 'screen_capture is unavailable: ' + platform + ' has no screen capture backend'

/** Keeps a denial's stderr a reason rather than a transcript. */
const reasonOf = (stderr: string): string => {
  const trimmed = stderr.trim()
  if (trimmed === '') return 'no reason given'
  return trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed
}

const unwritableTemp = (): ToolError =>
  new ToolError({
    code: 'unavailable',
    message: 'screen_capture is unavailable: cannot make a temp directory for the screenshot',
  })

const emptyCapture = (): ToolError =>
  new ToolError({
    code: 'unavailable',
    message:
      'screen_capture is unavailable: the capture wrote no image; screen recording may be denied for this process',
  })

/** Reads the image the command wrote; a missing or empty file is the capture's failure, not a crash. */
const readCapture = (path: string): Effect.Effect<Buffer, ToolError> =>
  Effect.tryPromise({ try: () => readFile(path), catch: emptyCapture }).pipe(
    Effect.flatMap((bytes) =>
      bytes.byteLength === 0 ? Effect.fail(emptyCapture()) : Effect.succeed(bytes),
    ),
  )

/**
 * Runs one wrapped capture and reads what it wrote. The command writes to a
 * temp file because screencapture cannot write to stdout, so the file is the
 * only place the image exists; the caller removes the directory afterwards.
 */
const captureInto = (
  directory: string,
  display: number | undefined,
  exec: { readonly cwd: string },
  sandbox: SandboxShape,
  host: CaptureHost,
): Effect.Effect<ScreenCaptureValue, ToolError> =>
  Effect.gen(function* () {
    const path = join(directory, 'shot.png')
    const argv = captureCommand(host.platform, path, display, host.hasProgram)
    if (argv === undefined) {
      return yield* Effect.fail(
        new ToolError({ code: 'unavailable', message: noCommandMessage(host.platform) }),
      )
    }
    const confined = yield* sandbox.wrap({ argv, cwd: exec.cwd }).pipe(
      Effect.mapError(
        (error) =>
          new ToolError({
            code: 'unavailable',
            message:
              'screen_capture is unavailable: the sandbox refused the command: ' + error.message,
          }),
      ),
    )
    const ran = yield* Effect.tryPromise({
      try: () => host.run({ argv: confined.argv, cwd: confined.cwd }),
      catch: (error) =>
        new ToolError({
          code: 'unavailable',
          message: 'screen_capture failed: ' + messageOf(error),
        }),
    })
    if (ran.exitCode !== 0) {
      return yield* Effect.fail(
        new ToolError({
          code: 'unavailable',
          message:
            'screen_capture failed (exit ' + String(ran.exitCode) + '): ' + reasonOf(ran.stderr),
        }),
      )
    }
    const bytes = yield* readCapture(path)
    return {
      mediaType: 'image/png',
      bytes: bytes.byteLength,
      data: Buffer.from(bytes).toString('base64'),
    }
  })

/**
 * Takes the screen and hands the png to the model as an image block, the way
 * read_image does, because seeing the screen is what the next step acts on.
 * The capture runs through the run sandbox, so what the sandbox stops, the tool
 * reports as unavailable instead of retrying outside it.
 */
export const makeScreenCaptureTool = (
  sandbox: SandboxShape = noneSandbox,
  host: CaptureHost = systemCaptureHost,
): ToolDefinition<ScreenCaptureArgs, ScreenCaptureValue> => ({
  name: 'screen_capture',
  description:
    'Captures what is on screen and shows it to the model as an image. macOS runs screencapture, Linux grim or ImageMagick import. Pass display to name one macOS display. The capture runs inside the run sandbox: a session that may not take the screen fails with unavailable and says why.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      mediaType: Schema.String,
      bytes: Schema.Int,
      data: Schema.String,
    }),
    render: (_args, value) => [
      { type: 'image', mediaType: value.mediaType, data: value.data, name: 'screen.png' },
    ],
  },
  timeoutMs: 20_000,
  execute: (args, exec) =>
    Effect.gen(function* () {
      if (exec.images === 'none') {
        return yield* Effect.fail(
          new ToolError({
            code: 'unavailable',
            message:
              'screen_capture is unavailable: the current route cannot carry images; switch to an image-capable route to show one',
          }),
        )
      }
      if (args.display !== undefined && args.display < 0) {
        return yield* Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'display must be zero or more, not ' + String(args.display),
          }),
        )
      }
      const directory = yield* Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), 'jzh-screen-')),
        catch: unwritableTemp,
      })
      return yield* captureInto(directory, args.display, exec, sandbox, host).pipe(
        Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
      )
    }),
})

/** The capture tool, ready for whoever registers tools into the registry; the run's sandbox wraps it. */
export class ScreenCaptureTools extends Context.Service<
  ScreenCaptureTools,
  (sandbox: SandboxShape) => ReadonlyArray<ToolDefinition<any, any>>
>()('jozo-harness/ScreenCaptureTools') {}

/** Loader definition for the capture tool; the row opts a session into taking the screen. */
export const screenCapturePlugin: Plugin<{}, ScreenCaptureTools, never> = {
  name: '@jozo-harness/screen-capture',
  config: Schema.Struct({}),
  provides: [ScreenCaptureTools],
  requires: [],
  layer: () => Layer.succeed(ScreenCaptureTools, (sandbox) => [makeScreenCaptureTool(sandbox)]),
}
