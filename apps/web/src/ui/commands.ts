import type { CommandView } from '../shared/rpc.ts'

/** The command word under the caret: where it starts, and what it holds. */
export interface CommandToken {
  /** The whole word, leading slash included: what the candidates match against. */
  readonly text: string
  /** The caret's line, from the first word's slash. */
  readonly start: number
  /** One past the word, so accepting a candidate replaces all of it. */
  readonly end: number
}

/**
 * The command word a caret sits in, or nothing. A command is the first word of
 * a line and starts with a slash, so the popup never opens in the middle of a
 * sentence or on the second word of an argument line.
 */
export const commandTokenAt = (line: string, caret: number): CommandToken | undefined => {
  const at = Math.max(0, Math.min(caret, line.length))
  const lineStart = line.lastIndexOf('\n', at - 1) + 1
  const lineEnd = line.indexOf('\n', at)
  const endOfLine = lineEnd === -1 ? line.length : lineEnd
  const before = line.slice(lineStart, at)
  if (!/^\/\S*$/.test(before)) return undefined
  const after = line.slice(at, endOfLine)
  const space = after.search(/\s/)
  const end = space === -1 ? endOfLine : at + space
  return { text: line.slice(lineStart, end), start: lineStart, end }
}

/**
 * What a page offers for one command word: names that start with the letters
 * first, then the ones that hold them anywhere, each in the registry's order.
 */
export const commandCandidates = (
  commands: ReadonlyArray<CommandView>,
  token: CommandToken,
): ReadonlyArray<CommandView> => {
  const query = token.text.slice(1).toLowerCase()
  if (query === '') return commands
  const prefix = commands.filter((command) => command.name.toLowerCase().startsWith(query))
  const partial = commands.filter(
    (command) =>
      !command.name.toLowerCase().startsWith(query) && command.name.toLowerCase().includes(query),
  )
  return [...prefix, ...partial]
}

/** The selection one arrow key moves to: after the last comes the first. */
export const movedCommandIndex = (index: number, step: number, length: number): number =>
  length <= 0 ? 0 : (((index + step) % length) + length) % length

/** The line and caret after accepting one candidate: its name and a space for its arguments. */
export const completedCommand = (
  line: string,
  token: CommandToken,
  name: string,
): { readonly text: string; readonly caret: number } => {
  const replacement = '/' + name + ' '
  return {
    text: line.slice(0, token.start) + replacement + line.slice(token.end),
    caret: token.start + replacement.length,
  }
}
