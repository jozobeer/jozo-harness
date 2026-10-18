import { Cause, Data, Effect, Schema } from 'effect'
import type { SessionError } from './errors.ts'
import type { Session } from './session.ts'
import { registerLogOnlySessionEvents } from './projections.ts'
import { registerSessionEventSchemas, type SessionEventSchemaMap } from './schemas.ts'

/** One command the human typed, as the log records it. */
export interface CommandRunData {
  readonly commandId: string
  /** Without the leading slash. */
  readonly name: string
  /** Everything after the name, verbatim. */
  readonly input: string
}

/** What one command answered, as the log records it. */
export interface CommandDoneData {
  readonly commandId: string
  readonly name: string
  readonly ok: boolean
  readonly text: string
}

declare module './events.ts' {
  interface SessionEventMap {
    'command/run': CommandRunData
    'command/done': CommandDoneData
  }
}

/** Schemas for the session events this module adds. */
export const commandEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  [
    'command/run',
    Schema.Struct({ commandId: Schema.String, name: Schema.String, input: Schema.String }),
  ],
  [
    'command/done',
    Schema.Struct({
      commandId: Schema.String,
      name: Schema.String,
      ok: Schema.Boolean,
      text: Schema.String,
    }),
  ],
])

registerSessionEventSchemas(commandEventSchemas)
// A command is the human's, not the model's: the UI shows it, the history does not.
registerLogOnlySessionEvents(['command/run', 'command/done'])

/** A command that cannot be registered. */
export class CommandError extends Data.TaggedError('CommandError')<{
  readonly code: 'duplicate' | 'bad-name'
  readonly message: string
}> {}

/** What one command is told when it runs. */
export interface CommandContext {
  readonly session: Session
  /** The id already written to this invocation's `command/run` event. */
  readonly commandId: string
  /** How the session names itself, for commands that report it. */
  readonly sessionId: string
}

/** What one command answers. A refusal is an answer too, and reaches the human. */
export interface CommandOutcome {
  readonly ok: boolean
  readonly text: string
}

/** One command the human can type. */
export interface Command {
  /** Without the leading slash: lowercase letters, digits, and dashes. */
  readonly name: string
  readonly summary: string
  readonly run: (input: string, context: CommandContext) => Effect.Effect<CommandOutcome>
}

/** The command one line names. */
export interface CommandInvocation {
  readonly name: string
  readonly input: string
}

export interface CommandsShape {
  readonly register: (command: Command) => Effect.Effect<void, CommandError>
  readonly list: () => ReadonlyArray<Command>
  /** The command a line names, or nothing when the line is not a command at all. */
  readonly parse: (line: string) => CommandInvocation | undefined
  /**
   * Runs one line against a session. Nothing at all when the line is not a command;
   * a command writes `command/run` before it works and `command/done` with its
   * answer, an unknown name included, so a UI can replay what the human asked for.
   */
  readonly run: (
    line: string,
    session: Session,
  ) => Effect.Effect<CommandOutcome | undefined, SessionError>
}

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/

/** A line is a command when its first word starts with a slash. */
export const parseCommand = (line: string): CommandInvocation | undefined => {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return undefined
  const withoutSlash = trimmed.slice(1)
  const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(withoutSlash)
  const name = match?.[1]
  if (name === undefined || !COMMAND_NAME.test(name)) return undefined
  return { name, input: (match?.[2] ?? '').trimEnd() }
}

const countOf = (session: Session, type: 'command/run'): number =>
  session.events().filter((event) => event.type === type).length

/** The line that lists what there is to type. */
export const commandHelp = (commands: ReadonlyArray<Command>): string =>
  commands.length === 0
    ? 'no commands are registered'
    : commands
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((command) => '/' + command.name + ' — ' + command.summary)
        .join('\n')

const failed = (error: unknown): CommandOutcome => ({
  ok: false,
  text: error instanceof Error ? error.message : String(error),
})

/** The answer an unregistered name gets, naming what there is to type instead. */
const unknownCommand = (name: string, commands: ReadonlyArray<Command>): CommandOutcome => ({
  ok: false,
  text: 'unknown command: ' + name + '\n' + commandHelp(commands),
})

/** The command registry one session's UIs share. */
export const makeCommands = (): CommandsShape => {
  const byName = new Map<string, Command>()
  return {
    register: (command) =>
      Effect.gen(function* () {
        if (!COMMAND_NAME.test(command.name)) {
          return yield* Effect.fail(
            new CommandError({ code: 'bad-name', message: 'not a command name: ' + command.name }),
          )
        }
        if (byName.has(command.name)) {
          return yield* Effect.fail(
            new CommandError({
              code: 'duplicate',
              message: command.name + ' is already registered',
            }),
          )
        }
        byName.set(command.name, command)
      }),
    list: () => [...byName.values()],
    parse: parseCommand,
    run: (line, session) =>
      Effect.gen(function* () {
        const invocation = parseCommand(line)
        if (invocation === undefined) return undefined
        const commandId = 'cmd-' + String(countOf(session, 'command/run') + 1)
        yield* session.append('command/run', {
          commandId,
          name: invocation.name,
          input: invocation.input,
        })
        const command = byName.get(invocation.name)
        const context: CommandContext = { session, commandId, sessionId: session.id }
        const outcome = yield* command === undefined
          ? Effect.succeed(unknownCommand(invocation.name, [...byName.values()]))
          : command
              .run(invocation.input, context)
              .pipe(Effect.catchCause((cause) => Effect.succeed(failed(Cause.squash(cause)))))
        yield* session.append('command/done', {
          commandId,
          name: invocation.name,
          ok: outcome.ok,
          text: outcome.text,
        })
        return outcome
      }),
  }
}
