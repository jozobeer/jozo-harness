import { escapeHtml } from './html.ts'
import { linkPartsOf, type LinkPart } from './linkify.ts'

/** One piece of a document: a fenced block, or the lines that surround it. */
type Segment =
  | { readonly kind: 'code'; readonly lang: string; readonly body: string }
  | { readonly kind: 'text'; readonly lines: ReadonlyArray<string> }

const FENCE = /^ {0,3}`{3,}(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^ {0,3}(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const BOLD = /\*\*([^*]+)\*\*/g
const ITALIC = /\*([^*]+)\*/g

/** Where the fence at `index` ends, and the language it names. */
const fenceAt = (
  lines: ReadonlyArray<string>,
  index: number,
): { readonly lang: string; readonly end: number } | undefined => {
  const fence = FENCE.exec(lines[index] ?? '')
  if (fence === null) return undefined
  let end = index + 1
  while (end < lines.length && FENCE.exec(lines[end] ?? '') === null) end += 1
  return { lang: (fence[1] ?? '').trim(), end }
}

/** Splits fenced code out of the text; every other line keeps its order. */
const segmentsOf = (lines: ReadonlyArray<string>): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = []
  let plain: Array<string> = []
  let index = 0
  const flush = (): void => {
    if (plain.length > 0) segments.push({ kind: 'text', lines: plain })
    plain = []
  }
  while (index < lines.length) {
    const fence = fenceAt(lines, index)
    if (fence === undefined) {
      plain.push(lines[index] ?? '')
      index += 1
      continue
    }
    flush()
    const body = lines.slice(index + 1, fence.end).join('\n')
    segments.push({ kind: 'code', lang: fence.lang, body })
    index = fence.end + 1
  }
  flush()
  return segments
}

const ANCHOR = /^(?:https?:|mailto:)/i

/** A link node; the label and the href are escaped on their own. */
const anchor = (part: Extract<LinkPart, { kind: 'link' }>): string =>
  '<a href="' +
  escapeHtml(part.href) +
  '"' +
  (ANCHOR.test(part.href) ? ' target="_blank" rel="noreferrer noopener"' : '') +
  '>' +
  escapeHtml(part.label) +
  '</a>'

/** Inline markup of one raw run: links, strong, emphasis. */
const inlineOf = (text: string): string =>
  linkPartsOf(text)
    .map((part) => (part.kind === 'link' ? anchor(part) : escapeHtml(part.text)))
    .join('')
    .replace(BOLD, '<strong>$1</strong>')
    .replace(ITALIC, '<em>$1</em>')

/** Code spans are marked before anything else, so their body is never read as markup. */
const withCodeSpans = (text: string): string =>
  text
    .split('`')
    .map((part, index) =>
      index % 2 === 1 ? '<code>' + escapeHtml(part) + '</code>' : inlineOf(part),
    )
    .join('')

const DELIMITER = /^:?-+:?$/

type Align = 'left' | 'center' | 'right'

type Table = {
  readonly head: ReadonlyArray<string>
  readonly aligns: ReadonlyArray<Align | undefined>
  readonly rows: ReadonlyArray<ReadonlyArray<string>>
  readonly end: number
}

/** Drops the empty cells the outer pipes make and unescapes the pipes inside. */
const trimEdges = (cells: ReadonlyArray<string>, line: string): ReadonlyArray<string> => {
  const from = (line.trimStart()[0] ?? '') === '|' ? 1 : 0
  const to = (line.trimEnd().slice(-1) ?? '') === '|' ? cells.length - 1 : cells.length
  return cells.slice(from, to).map((part) => part.trim().replace(/\\\|/g, '|'))
}

/** Splits a pipe row; a pipe inside a code span or an escaped pipe is content. */
const cellsOf = (line: string): ReadonlyArray<string> => {
  const cells: Array<string> = []
  let cell = ''
  let code = false
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at] ?? ''
    code = char === '`' ? !code : code
    const split = char === '|' && !code && line[at - 1] !== '\\'
    if (!split) {
      cell += char
      continue
    }
    cells.push(cell)
    cell = ''
  }
  cells.push(cell)
  return trimEdges(cells, line)
}

const alignOf = (cell: string): Align | undefined =>
  cell.startsWith(':') && cell.endsWith(':')
    ? 'center'
    : cell.startsWith(':')
      ? 'left'
      : cell.endsWith(':')
        ? 'right'
        : undefined

/** The delimiter cells, which every table needs and which set each column's alignment. */
const marksOf = (line: string): ReadonlyArray<string> | undefined => {
  if (!line.includes('|')) return undefined
  const marks = cellsOf(line)
  if (marks.length === 0) return undefined
  return marks.every((mark) => DELIMITER.test(mark)) ? marks : undefined
}

/** The body rows under a table; the first line without a pipe ends them. */
const rowsFrom = (
  lines: ReadonlyArray<string>,
  start: number,
): { readonly rows: ReadonlyArray<ReadonlyArray<string>>; readonly end: number } => {
  const rows: Array<ReadonlyArray<string>> = []
  let end = start
  while (end < lines.length) {
    const row = lines[end] ?? ''
    if (row.trim() === '' || !row.includes('|')) break
    rows.push(cellsOf(row))
    end += 1
  }
  return { rows, end }
}

/** A header row, a delimiter row and the rows under them; a bare pipe line is prose. */
const tableAt = (lines: ReadonlyArray<string>, index: number): Table | undefined => {
  const header = lines[index] ?? ''
  if (!header.includes('|')) return undefined
  const marks = marksOf(lines[index + 1] ?? '')
  if (marks === undefined) return undefined
  const head = cellsOf(header)
  if (head.length !== marks.length) return undefined
  const body = rowsFrom(lines, index + 2)
  return { head, aligns: marks.map(alignOf), rows: body.rows, end: body.end }
}

const cellHtml = (tag: 'th' | 'td', text: string, align: Align | undefined): string =>
  '<' +
  tag +
  (align === undefined ? '' : ' class="align-' + align + '"') +
  '>' +
  withCodeSpans(text) +
  '</' +
  tag +
  '>'

const tableHtml = (table: Table): string => {
  const head = table.head.map((text, column) => cellHtml('th', text, table.aligns[column])).join('')
  const body = table.rows
    .map((row) =>
      table.head
        .map((_, column) => cellHtml('td', row[column] ?? '', table.aligns[column]))
        .join(''),
    )
    .map((cells) => '<tr>' + cells + '</tr>')
    .join('')
  return (
    '<table><thead><tr>' +
    head +
    '</tr></thead>' +
    (table.rows.length === 0 ? '' : '<tbody>' + body + '</tbody>') +
    '</table>'
  )
}

type Line =
  | { readonly kind: 'blank' }
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'rule' }
  | { readonly kind: 'item'; readonly ordered: boolean; readonly text: string }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }

/** The first shape a line matches wins; a line that matches none is prose. */
const MATCHERS: ReadonlyArray<(line: string) => Line | undefined> = [
  (line) => {
    const match = HEADING.exec(line)
    return match === null
      ? undefined
      : { kind: 'heading', level: (match[1] ?? '#').length, text: match[2] ?? '' }
  },
  (line) => (RULE.test(line) ? { kind: 'rule' } : undefined),
  (line) => {
    const match = QUOTE.exec(line)
    return match === null ? undefined : { kind: 'quote', text: match[1] ?? '' }
  },
  (line) => {
    const match = ITEM.exec(line)
    return match === null
      ? undefined
      : { kind: 'item', ordered: match[2] !== undefined, text: match[3] ?? '' }
  },
]

const classify = (line: string): Line => {
  if (line.trim() === '') return { kind: 'blank' }
  for (const matcher of MATCHERS) {
    const matched = matcher(line)
    if (matched !== undefined) return matched
  }
  return { kind: 'text', text: line }
}

/** A line's block tag and its HTML; a blank line carries neither. */
const emit = (line: Line, same: boolean): { readonly tag: string; readonly html: string } => {
  switch (line.kind) {
    case 'blank':
      return { tag: '', html: '' }
    case 'rule':
      return { tag: '', html: '<hr>' }
    case 'heading':
      return { tag: '', html: headingHtml(line) }
    case 'item':
      return { tag: line.ordered ? 'ol' : 'ul', html: '<li>' + withCodeSpans(line.text) + '</li>' }
    case 'quote':
      return { tag: 'blockquote', html: (same ? '<br>' : '') + withCodeSpans(line.text) }
    case 'text':
      return { tag: 'p', html: (same ? '<br>' : '') + withCodeSpans(line.text) }
  }
}

const headingHtml = (line: Extract<Line, { kind: 'heading' }>): string =>
  '<h' + String(line.level) + '>' + withCodeSpans(line.text) + '</h' + String(line.level) + '>'

/** Closes the block a run was in and opens the one it moves to. */
const switchTag = (from: string, to: string, out: Array<string>): void => {
  if (from === to) return
  if (from !== '') out.push('</' + from + '>')
  if (to !== '') out.push('<' + to + '>')
}

const closeTag = (tag: string): string => (tag === '' ? '' : '</' + tag + '>')

/** Blocks of one text run. A blank line is the only thing that closes a block. */
const renderBlocks = (lines: ReadonlyArray<string>): string => {
  const out: Array<string> = []
  let open = ''
  let previous = ''
  let index = 0
  while (index < lines.length) {
    const table = tableAt(lines, index)
    if (table !== undefined) {
      switchTag(open, '', out)
      open = ''
      previous = ''
      out.push(tableHtml(table))
      index = table.end
      continue
    }
    const kind = classify(lines[index] ?? '')
    const piece = emit(kind, previous === kind.kind)
    previous = kind.kind === 'blank' ? '' : kind.kind
    switchTag(open, piece.tag, out)
    open = piece.tag
    out.push(piece.html)
    index += 1
  }
  return out.join('') + closeTag(open)
}

const codeHtml = (segment: Extract<Segment, { kind: 'code' }>): string => {
  const lang = segment.lang === '' ? '' : ' data-lang="' + escapeHtml(segment.lang) + '"'
  return '<pre class="code"' + lang + '><code>' + escapeHtml(segment.body) + '</code></pre>'
}

/** Renders the markdown a conversation needs. The output is escaped HTML. */
export const renderMarkdown = (text: string): string =>
  segmentsOf(text.split('\n'))
    .map((segment) => (segment.kind === 'code' ? codeHtml(segment) : renderBlocks(segment.lines)))
    .join('')
