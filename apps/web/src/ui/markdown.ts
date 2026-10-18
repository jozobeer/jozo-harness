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
  for (const line of lines) {
    const kind = classify(line)
    const piece = emit(kind, previous === kind.kind)
    previous = kind.kind === 'blank' ? '' : kind.kind
    switchTag(open, piece.tag, out)
    open = piece.tag
    out.push(piece.html)
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
