const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const BACKSLASH = String.fromCharCode(0x5c)
const OPEN_BRACKET = String.fromCharCode(0x5b)
const CLOSE_BRACKET = String.fromCharCode(0x5d)

// Patterns are built from code points so their source carries no control characters.
const OSC = new RegExp(
  ESC + CLOSE_BRACKET + '[^' + BEL + ']*(?:' + BEL + '|' + ESC + BACKSLASH + BACKSLASH + ')',
  'g',
)
const CSI = new RegExp(ESC + BACKSLASH + OPEN_BRACKET + '[0-9;?]*[ -/]*[@-~]', 'g')
const SHORT_ESCAPE = new RegExp(ESC + '[@-Z' + BACKSLASH + BACKSLASH + '-_]', 'g')

/** True for C0 controls other than tab and newline, and for DEL. */
const isControl = (codePoint: number): boolean =>
  codePoint === 0x7f || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a)

/** Strips terminal control sequences so untrusted output cannot drive a screen. */
export const plainText = (text: string): string =>
  Array.from(text.replace(OSC, '').replace(CSI, '').replace(SHORT_ESCAPE, ''))
    .filter((char) => !isControl(char.codePointAt(0) ?? 0))
    .join('')

/** The first line of a multi-line text, trimmed. */
export const firstLine = (text: string): string => {
  const index = text.indexOf('\n')
  return (index < 0 ? text : text.slice(0, index)).trim()
}

/** Collapses every run of whitespace so a value fits on one display line. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Shortens to `max` code units, marking the cut with an ellipsis. */
export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'

/**
 * The part of a recorded summary after the tool name. A presenter writes a
 * self-contained line, but a view that shows the name in its own column would
 * repeat it. A line that does not begin with the name is left alone.
 */
export const summaryBodyOf = (name: string, summary: string): string => {
  if (name === '') return summary
  if (summary === name) return ''
  return summary.startsWith(name + ' ') ? summary.slice(name.length + 1) : summary
}
