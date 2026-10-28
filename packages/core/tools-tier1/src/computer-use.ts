import { Context, Effect, Layer, Schema } from 'effect'
import type { Plugin } from '@jozo-harness/kernel'
import {
  APPROVAL_ANSWER,
  noneSandbox,
  type AskShape,
  type SandboxShape,
} from '@jozo-harness/safety'
import { ToolError, type ToolDefinition, type ToolRunContext } from '@jozo-harness/tools'
import { askOrFail } from './ask.ts'
import { systemCaptureHost, type CaptureHost } from './screen-capture.ts'

/** The host the screen tools need: which programs exist, and how a wrapped command runs. */
export type ScreenHost = CaptureHost

/** A real run drives the screen with osascript; tests replace this so no screen is touched. */
export const systemScreenHost: ScreenHost = systemCaptureHost

const ClickParameters = Schema.Struct({
  x: Schema.Int.annotate({ description: 'The horizontal point to click, in screen coordinates.' }),
  y: Schema.Int.annotate({ description: 'The vertical point to click, in screen coordinates.' }),
})

const TypeParameters = Schema.Struct({
  text: Schema.String.annotate({
    description:
      'The text to type at the focused control. It is typed as given, including newlines.',
  }),
})

const KeyParameters = Schema.Struct({
  key: Schema.String.annotate({
    description:
      'A key to press: return, tab, escape, space, arrows, function keys, or a chord like cmd+s.',
  }),
})

export type ComputerClickArgs = Schema.Schema.Type<typeof ClickParameters>
export type ComputerTypeArgs = Schema.Schema.Type<typeof TypeParameters>
export type ComputerKeyArgs = Schema.Schema.Type<typeof KeyParameters>

/** What one call acted on, so the log says where an operation went. */
export interface ComputerTarget {
  readonly x?: number
  readonly y?: number
  readonly key?: string
  /** The text as typed, cut only when it is too long for a value; `characters` holds the full length. */
  readonly text?: string
  readonly characters?: number
}

/** The action, its target, and what the command returned; the log keeps the value as it is. */
export interface ComputerUseValue {
  readonly action: 'click' | 'type' | 'key'
  readonly target: ComputerTarget
  readonly exitCode: number
  /** A short reason from stderr; empty when the command said nothing. */
  readonly stderr: string
}

const NAME = 'computer use'

/** The longest text a value keeps; a longer call is still typed in full. */
const MAX_LOGGED_TEXT = 2_000

/**
 * The key codes macOS names by number. The names are the ones a model is likely
 * to write, and each maps to the code System Events already knows.
 */
const KEY_CODES: ReadonlyMap<string, number> = new Map([
  ['return', 36],
  ['enter', 76],
  ['tab', 48],
  ['space', 49],
  ['escape', 53],
  ['esc', 53],
  ['delete', 51],
  ['backspace', 51],
  ['forwarddelete', 117],
  ['up', 126],
  ['down', 125],
  ['left', 123],
  ['right', 124],
  ['home', 115],
  ['end', 119],
  ['pageup', 116],
  ['pagedown', 121],
  ['f1', 122],
  ['f2', 120],
  ['f3', 99],
  ['f4', 118],
  ['f5', 96],
  ['f6', 97],
  ['f7', 98],
  ['f8', 100],
  ['f9', 101],
  ['f10', 109],
  ['f11', 103],
  ['f12', 111],
])

const MODIFIERS: ReadonlyMap<string, string> = new Map([
  ['cmd', 'command down'],
  ['command', 'command down'],
  ['shift', 'shift down'],
  ['ctrl', 'control down'],
  ['control', 'control down'],
  ['alt', 'option down'],
  ['option', 'option down'],
])

interface KeyPress {
  readonly code?: number
  /** A single character typed with keystroke, which is how shifted or unicode keys arrive. */
  readonly character?: string
  readonly modifiers: ReadonlyArray<string>
}

const modifiersOf = (parts: ReadonlyArray<string>, key: string): ReadonlyArray<string> | string => {
  const modifiers: Array<string> = []
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.toLowerCase())
    if (modifier === undefined) return 'unknown modifier "' + part + '" in ' + key
    if (!modifiers.includes(modifier)) modifiers.push(modifier)
  }
  return modifiers
}

const keyPressOf = (key: string): KeyPress | string => {
  const parts = key.split('+')
  const name = (parts.at(-1) ?? '').toLowerCase()
  if (name === '') return 'a key is missing after the modifier in ' + key
  const modifiers = modifiersOf(parts.slice(0, -1), key)
  if (typeof modifiers === 'string') return modifiers
  const code = KEY_CODES.get(name)
  if (code !== undefined) return { code, modifiers }
  if (Array.from(name).length === 1) return { character: name, modifiers }
  return 'unknown key "' + key + '"; use a named key such as return or a chord such as cmd+s'
}

/**
 * osascript reads each statement with -e, and the arguments follow -- so a text
 * that starts with a dash stays an argument instead of being read as an option.
 */
const osascript = (
  statements: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  'osascript',
  ...statements.flatMap((statement) => ['-e', statement]),
  ...(args.length === 0 ? [] : ['--', ...args]),
]

const clickCommand = (x: number, y: number): ReadonlyArray<string> =>
  osascript(
    [
      'on run argv',
      'set px to (item 1 of argv) as integer',
      'set py to (item 2 of argv) as integer',
      'tell application "System Events" to click at {px, py}',
      'end run',
    ],
    [String(x), String(y)],
  )

const typeCommand = (text: string): ReadonlyArray<string> =>
  osascript(
    ['on run argv', 'tell application "System Events" to keystroke (item 1 of argv)', 'end run'],
    [text],
  )

const keyCommand = (press: KeyPress): ReadonlyArray<string> => {
  const using = press.modifiers.length === 0 ? '' : ' using {' + press.modifiers.join(', ') + '}'
  const action =
    press.code === undefined
      ? 'keystroke (item 1 of argv)' + using
      : 'key code ' + String(press.code) + using
  return osascript(
    ['on run argv', 'tell application "System Events" to ' + action, 'end run'],
    press.character === undefined ? [] : [press.character],
  )
}

/** Why this host cannot control the screen, or undefined when it can. */
const unavailableReason = (host: ScreenHost): string | undefined => {
  if (host.platform !== 'darwin') {
    return (
      NAME +
      ' is unavailable: ' +
      host.platform +
      ' has no screen control backend; only macOS can click, type, and press keys'
    )
  }
  if (!host.hasProgram('osascript')) {
    return NAME + ' is unavailable: macOS needs osascript on PATH'
  }
  return undefined
}

/** Keeps a command's stderr a reason rather than a transcript. */
const reasonOf = (stderr: string): string => {
  const trimmed = stderr.trim()
  if (trimmed === '') return 'no reason given'
  return trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const loggedText = (text: string): string =>
  text.length > MAX_LOGGED_TEXT ? text.slice(0, MAX_LOGGED_TEXT) + '…' : text

const targetText = (action: string, target: ComputerTarget): string => {
  if (action === 'click') return 'a click at (' + String(target.x) + ', ' + String(target.y) + ')'
  if (action === 'type') return 'typing ' + String(target.characters) + ' characters'
  return 'the key "' + String(target.key) + '"'
}

interface Request {
  readonly action: ComputerUseValue['action']
  readonly target: ComputerTarget
  readonly question: string
  readonly argv: ReadonlyArray<string>
}

/**
 * Asks before the screen is touched, then runs the wrapped command. A refusal
 * ends the call here, before the sandbox or the host sees anything, so an
 * unapproved click cannot reach the screen through another path.
 */
const perform = (
  request: Request,
  sandbox: SandboxShape,
  ask: AskShape,
  host: ScreenHost,
  exec: ToolRunContext,
): Effect.Effect<ComputerUseValue, ToolError> =>
  Effect.gen(function* () {
    const missing = unavailableReason(host)
    if (missing !== undefined) {
      return yield* Effect.fail(new ToolError({ code: 'unavailable', message: missing }))
    }
    const answer = yield* askOrFail(ask, {
      id: exec.callId,
      question: request.question,
      options: [APPROVAL_ANSWER, 'deny'],
    })
    if (answer.trim().toLowerCase() !== APPROVAL_ANSWER) {
      return yield* Effect.fail(
        new ToolError({
          code: 'denied',
          message:
            'the human did not approve ' +
            targetText(request.action, request.target) +
            '; the action did not run',
        }),
      )
    }
    const confined = yield* sandbox.wrap({ argv: request.argv, cwd: exec.cwd }).pipe(
      Effect.mapError(
        (error) =>
          new ToolError({
            code: 'unavailable',
            message: NAME + ' is unavailable: the sandbox refused the command: ' + error.message,
          }),
      ),
    )
    const ran = yield* Effect.tryPromise({
      try: () => host.run({ argv: confined.argv, cwd: confined.cwd }),
      catch: (error) =>
        new ToolError({ code: 'execution', message: NAME + ' failed: ' + messageOf(error) }),
    })
    return {
      action: request.action,
      target: request.target,
      exitCode: ran.exitCode,
      stderr: reasonOf(ran.stderr),
    }
  })

const render = (
  _args: unknown,
  value: ComputerUseValue,
): ReadonlyArray<{ type: 'text'; text: string }> => [
  {
    type: 'text',
    text:
      value.action +
      ': ' +
      targetText(value.action, value.target) +
      ' (exit ' +
      String(value.exitCode) +
      ')' +
      (value.stderr === 'no reason given' ? '' : ': ' + value.stderr),
  },
]

const valueSchema = Schema.Struct({
  action: Schema.Literals(['click', 'type', 'key']),
  target: Schema.Struct({
    x: Schema.optionalKey(Schema.Int),
    y: Schema.optionalKey(Schema.Int),
    key: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    characters: Schema.optionalKey(Schema.Int),
  }),
  exitCode: Schema.Int,
  stderr: Schema.String,
})

/** Clicks one point of the screen after the human approves the call. */
export const makeComputerClickTool = (
  sandbox: SandboxShape = noneSandbox,
  ask: AskShape,
  host: ScreenHost = systemScreenHost,
): ToolDefinition<ComputerClickArgs, ComputerUseValue> => ({
  name: 'computer_click',
  description:
    'Clicks one point of the screen after the human approves. Use screen_capture first to find the point. macOS only.',
  parameters: ClickParameters,
  output: { schema: valueSchema, render },
  timeoutMs: 20_000,
  execute: (args, exec) =>
    perform(
      {
        action: 'click',
        target: { x: args.x, y: args.y },
        question:
          'Allow a click at (' + String(args.x) + ', ' + String(args.y) + ') on this screen?',
        argv: clickCommand(args.x, args.y),
      },
      sandbox,
      ask,
      host,
      exec,
    ),
})

/** Types text into the focused control after the human approves the call. */
export const makeComputerTypeTool = (
  sandbox: SandboxShape = noneSandbox,
  ask: AskShape,
  host: ScreenHost = systemScreenHost,
): ToolDefinition<ComputerTypeArgs, ComputerUseValue> => ({
  name: 'computer_type',
  description:
    'Types text at the focused control after the human approves. It types the text as given, including newlines. macOS only.',
  parameters: TypeParameters,
  output: { schema: valueSchema, render },
  timeoutMs: 20_000,
  execute: (args, exec) =>
    perform(
      {
        action: 'type',
        target: { text: loggedText(args.text), characters: args.text.length },
        question: 'Allow typing ' + String(args.text.length) + ' characters onto this screen?',
        argv: typeCommand(args.text),
      },
      sandbox,
      ask,
      host,
      exec,
    ),
})

/** Presses one key or chord after the human approves the call. */
export const makeComputerKeyTool = (
  sandbox: SandboxShape = noneSandbox,
  ask: AskShape,
  host: ScreenHost = systemScreenHost,
): ToolDefinition<ComputerKeyArgs, ComputerUseValue> => ({
  name: 'computer_key',
  description: 'Presses one key or chord such as cmd+s after the human approves. macOS only.',
  parameters: KeyParameters,
  output: { schema: valueSchema, render },
  timeoutMs: 20_000,
  execute: (args, exec) =>
    Effect.gen(function* () {
      const press = keyPressOf(args.key)
      if (typeof press === 'string') {
        return yield* Effect.fail(new ToolError({ code: 'invalid-arguments', message: press }))
      }
      return yield* perform(
        {
          action: 'key',
          target: { key: args.key },
          question: 'Allow the key "' + args.key + '" on this screen?',
          argv: keyCommand(press),
        },
        sandbox,
        ask,
        host,
        exec,
      )
    }),
})

/** The three screen tools, each asking before it acts. */
export const computerUseTools = (
  sandbox: SandboxShape = noneSandbox,
  ask: AskShape,
  host: ScreenHost = systemScreenHost,
): ReadonlyArray<ToolDefinition<any, any>> => [
  makeComputerClickTool(sandbox, ask, host),
  makeComputerTypeTool(sandbox, ask, host),
  makeComputerKeyTool(sandbox, ask, host),
]

export class ComputerUseTools extends Context.Service<
  ComputerUseTools,
  (sandbox: SandboxShape, ask: AskShape) => ReadonlyArray<ToolDefinition<any, any>>
>()('jozo-harness/ComputerUseTools') {}

/** Loader definition for the screen tools; the row opts a session into acting on the screen. */
export const computerUsePlugin: Plugin<{}, ComputerUseTools, never> = {
  name: '@jozo-harness/computer-use',
  config: Schema.Struct({}),
  provides: [ComputerUseTools],
  requires: [],
  layer: () => Layer.succeed(ComputerUseTools, (sandbox, ask) => computerUseTools(sandbox, ask)),
}
