/** One run of plain text, or a link found in it. */
export type LinkPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly href: string; readonly label: string }

/** A URL the browser may follow; a protocol-relative `//` is not one. */
const SAFE_HREF = /^(?:https?:|mailto:|\/(?!\/))/i

/** Whether an explicitly written href may become an anchor. */
export const isSafeHref = (href: string): boolean => SAFE_HREF.test(href)

const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '。', '、'])
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

const countOf = (text: string, char: string): number => {
  let count = 0
  for (const each of text) if (each === char) count += 1
  return count
}

/**
 * Where a URL ends. Prose punctuation belongs to the sentence, and a closing
 * bracket stays only when it matches an opening bracket inside the URL.
 */
const trimUrl = (url: string): string => {
  let end = url.length
  while (end > 0) {
    const char = url[end - 1] ?? ''
    if (TRAILING.has(char)) {
      end -= 1
      continue
    }
    const opener = CLOSERS[char]
    const body = url.slice(0, end)
    if (opener !== undefined && countOf(body, char) > countOf(body, opener)) {
      end -= 1
      continue
    }
    break
  }
  return url.slice(0, end)
}

/** `[label](href)` or a bare `http(s)://` URL; both are found on raw text. */
const LINK_OR_URL = /\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>"'`]+)/gi

const textPart = (text: string): LinkPart => ({ kind: 'text', text })

/**
 * A bare match as a link, plus the punctuation the trim left behind. A URL cut
 * by truncation names no page, so it is not a link at all.
 */
const splitBare = (
  bare: string,
): { readonly link: LinkPart; readonly tail: string } | undefined => {
  if (bare.endsWith('…')) return undefined
  const href = trimUrl(bare)
  if (href === '') return undefined
  return { link: { kind: 'link', href, label: href }, tail: bare.slice(href.length) }
}

/** A bare URL match as its link and whatever punctuation followed it. */
const bareParts = (bare: string, whole: string): ReadonlyArray<LinkPart> => {
  const split = splitBare(bare)
  if (split === undefined) return [textPart(whole)]
  return split.tail === '' ? [split.link] : [split.link, textPart(split.tail)]
}

/** The pieces one scanner match contributes, link or plain text. */
const partsOfMatch = (match: RegExpExecArray): ReadonlyArray<LinkPart> => {
  const bare = match[3]
  if (bare !== undefined) return bareParts(bare, match[0])
  const href = match[2] ?? ''
  return isSafeHref(href) ? [{ kind: 'link', href, label: match[1] ?? '' }] : [textPart(match[0])]
}

/** Appends text to the previous run when it was text too, dropping empty runs. */
const appendText = (out: Array<LinkPart>, text: string): void => {
  if (text === '') return
  const last = out[out.length - 1]
  if (last?.kind === 'text') out[out.length - 1] = textPart(last.text + text)
  else out.push(textPart(text))
}

/** Joins adjacent text runs and drops empty ones, so a view reads one string between links. */
const joined = (parts: ReadonlyArray<LinkPart>): ReadonlyArray<LinkPart> => {
  const out: Array<LinkPart> = []
  for (const part of parts) {
    if (part.kind === 'link') out.push(part)
    else appendText(out, part.text)
  }
  return out
}

/**
 * Splits text into plain runs and links without building HTML, so each view can
 * make its own nodes and never parses model output as markup.
 */
export const linkPartsOf = (text: string): ReadonlyArray<LinkPart> => {
  const parts: Array<LinkPart> = []
  const pattern = new RegExp(LINK_OR_URL.source, LINK_OR_URL.flags)
  let cursor = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    parts.push(textPart(text.slice(cursor, match.index)), ...partsOfMatch(match))
    cursor = match.index + match[0].length
  }
  parts.push(textPart(text.slice(cursor)))
  return joined(parts)
}
