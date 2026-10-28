import { Effect } from 'effect'
import { readFile } from 'node:fs/promises'

/** The hook points this bridge maps onto the tool pipeline. */
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

/** One command a hooks.json runs at a tool point. */
export interface HookCommand {
  readonly event: HookEvent
  readonly command: string
  /** The tool-name matcher the group declared; absent matches every tool. */
  readonly matcher?: string
  /** The group's own deadline, in milliseconds, when it sets one. */
  readonly timeoutMs?: number
}

/** What a hooks.json contributed, or why it contributed nothing. */
export type HooksFile =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'ok'; readonly commands: ReadonlyArray<HookCommand> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A hook timeout is written in seconds by both reference formats. */
const timeoutOf = (hook: Record<string, unknown>): number | undefined => {
  const seconds = numberField(hook, 'timeout') ?? numberField(hook, 'timeoutSec')
  return seconds === undefined || seconds <= 0 ? undefined : Math.round(seconds * 1000)
}

const matcherField = (matcher: string | undefined): Pick<HookCommand, 'matcher'> =>
  matcher === undefined ? {} : { matcher }

const timeoutField = (timeoutMs: number | undefined): Pick<HookCommand, 'timeoutMs'> =>
  timeoutMs === undefined ? {} : { timeoutMs }

interface CommandEntry extends Record<string, unknown> {
  readonly command: string
}

const isCommandEntry = (value: unknown): value is CommandEntry => {
  if (!isRecord(value)) return false
  if (value.type !== undefined && value.type !== 'command') return false
  return typeof value.command === 'string'
}

const commandOf = (
  event: HookEvent,
  raw: unknown,
  matcher: string | undefined,
): ReadonlyArray<HookCommand> => {
  if (typeof raw === 'string') {
    return [{ ...matcherField(matcher), event, command: raw }]
  }
  if (!isCommandEntry(raw)) return []
  return [
    {
      ...matcherField(matcher),
      event,
      command: raw.command,
      ...timeoutField(timeoutOf(raw)),
    },
  ]
}

/**
 * Reads one matcher group. The reference formats wrap commands in a group with
 * a matcher; a bare command string and a single command object are accepted too,
 * so a small hand-written hooks.json works without the wrapper.
 */
const commandsOfGroup = (event: HookEvent, raw: unknown): ReadonlyArray<HookCommand> => {
  if (typeof raw === 'string') return commandOf(event, raw, undefined)
  if (!isRecord(raw)) return []
  const matcher = typeof raw.matcher === 'string' ? raw.matcher : undefined
  if (!Array.isArray(raw.hooks)) return commandOf(event, raw, matcher)
  return raw.hooks.flatMap((hook) => commandOf(event, hook, matcher))
}

const commandsOfEvent = (event: HookEvent, raw: unknown): ReadonlyArray<HookCommand> =>
  Array.isArray(raw) ? raw.flatMap((group) => commandsOfGroup(event, group)) : []

/**
 * Parses the reference event map, wrapped in `hooks` or bare. Unknown events are
 * ignored: the tool pipeline has no place to run them. A document that is not an
 * object is reported as invalid so the caller can say why it ran nothing.
 */
export const parseHooksConfig = (raw: unknown): HooksFile => {
  if (!isRecord(raw)) return { kind: 'invalid', reason: 'the document is not a JSON object' }
  const events = isRecord(raw.hooks) ? raw.hooks : raw
  const commands = HOOK_EVENTS.flatMap((event) => commandsOfEvent(event, events[event]))
  return { kind: 'ok', commands }
}

/** Parses the text of a hooks.json; the path is only used in the failure message. */
export const parseHooksText = (text: string, path: string): HooksFile => {
  try {
    return parseHooksConfig(JSON.parse(text) as unknown)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { kind: 'invalid', reason: 'hooks.json at ' + path + ' is not valid JSON: ' + detail }
  }
}

const isMissing = (cause: unknown): boolean => isRecord(cause) && cause.code === 'ENOENT'

/** Reads the hooks.json at path, treating a missing file as no hooks at all. */
export const readHooksFile = (path: string): Effect.Effect<HooksFile> =>
  Effect.match(
    Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: (cause) => cause,
    }),
    {
      onFailure: (cause) =>
        isMissing(cause)
          ? { kind: 'missing' as const }
          : {
              kind: 'invalid' as const,
              reason:
                'hooks.json at ' +
                path +
                ' cannot be read: ' +
                (cause instanceof Error ? cause.message : String(cause)),
            },
      onSuccess: (text) => parseHooksText(text, path),
    },
  )

/**
 * Whether a matcher selects this tool. An absent, empty, or `*` matcher selects
 * every tool; anything else is a case-insensitive regular expression anchored to
 * the whole name, so Claude Code's `Bash` reaches jzh's `bash`. An invalid
 * expression selects nothing rather than failing the call.
 */
export const matchesTool = (matcher: string | undefined, tool: string): boolean => {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  try {
    return new RegExp('^(?:' + matcher + ')$', 'i').test(tool)
  } catch {
    return false
  }
}
