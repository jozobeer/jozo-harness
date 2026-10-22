/** The largest an SVG fence may be before it stays a code block. */
export const SVG_MAX_BYTES = 100_000

const SVG_NS = 'http://www.w3.org/2000/svg'

/** What a diagram may draw; anything else is dropped with its subtree. */
const ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'marker',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'use',
])

/** What a diagram may say about those elements; on* and href are never here. */
const ATTRIBUTES: ReadonlySet<string> = new Set([
  'viewBox',
  'width',
  'height',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'font-size',
  'font-family',
  'text-anchor',
  'dominant-baseline',
  'transform',
  'opacity',
  'id',
  'class',
  'marker-start',
  'marker-end',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'preserveAspectRatio',
  'role',
  'aria-label',
])

/**
 * The slice of the DOM this module touches. The root tsconfig carries only the
 * esnext lib, and pulling in lib.dom would clash with the Node fetch types, so
 * the browser nodes are described here by the members the sanitizer uses.
 */
export type SvgNode = {
  readonly nodeType: number
  readonly nodeValue: string | null
  readonly localName: string
  readonly attributes: ArrayLike<{ readonly name: string; readonly value: string }>
  readonly childNodes: ArrayLike<SvgNode>
  readonly ownerDocument: SvgDocument
  readonly textContent: string | null
  getAttribute(name: string): string | null
  querySelector(selectors: string): SvgNode | null
  setAttribute(name: string, value: string): void
  appendChild(child: SvgNode): unknown
}

type SvgDocument = {
  readonly documentElement: SvgNode
  createElementNS(namespace: string, name: string): SvgNode
  createTextNode(text: string): SvgNode
  querySelector(selectors: string): SvgNode | null
}

type DomGlobal = {
  readonly DOMParser: new () => {
    parseFromString(source: string, type: string): SvgDocument
  }
  readonly XMLSerializer: new () => { serializeToString(node: SvgNode): string }
}

const dom = (): DomGlobal => globalThis as unknown as DomGlobal

/** How many UTF-8 bytes a string is; the limit counts bytes, not characters. */
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/**
 * Copies one parsed element into a new node that carries only allowlisted tags
 * and attributes. Children are rebuilt the same way, so the source is never
 * handed back as markup that a parser would act on again.
 */
const copyAttributes = (source: SvgNode, target: SvgNode): void => {
  for (const attribute of Array.from(source.attributes)) {
    if (ATTRIBUTES.has(attribute.name)) target.setAttribute(attribute.name, attribute.value)
  }
}

/**
 * One child of the source as a fresh node in the target's document, or nothing
 * when the child is neither text nor an allowlisted element. Text is copied as a
 * text node so it can never be read back as markup.
 */
const copyChild = (child: SvgNode, target: SvgNode): SvgNode | undefined => {
  if (child.nodeType === 3) {
    target.appendChild(target.ownerDocument.createTextNode(child.nodeValue ?? ''))
    return undefined
  }
  if (child.nodeType !== 1 || !ELEMENTS.has(child.localName)) return undefined
  const next = target.ownerDocument.createElementNS(SVG_NS, child.localName)
  target.appendChild(next)
  return next
}

const copyOf = (source: SvgNode, target: SvgNode): void => {
  copyAttributes(source, target)
  for (const child of Array.from(source.childNodes)) {
    const next = copyChild(child, target)
    if (next !== undefined) copyOf(child, next)
  }
}

/**
 * A diagram built from an SVG fence through this module's allowlist, or nothing
 * when the fence is empty, past the size limit, or not an SVG document. The
 * source is only ever parsed, never assigned to innerHTML, so scripts, event
 * handlers, foreignObject, and links cannot survive into the page.
 */
export const svgOf = (source: string): SvgNode | undefined => {
  const body = source.trim()
  if (body === '' || bytesOf(body) > SVG_MAX_BYTES) return undefined
  const parsed = new (dom().DOMParser)().parseFromString(body, 'image/svg+xml')
  if (parsed.querySelector('parsererror') !== null) return undefined
  const root = parsed.documentElement
  if (root.localName !== 'svg') return undefined
  const built = parsed.createElementNS(SVG_NS, 'svg')
  copyOf(root, built)
  return built
}

/** The sanitized diagram as markup, for the string pipeline markdown emits. */
export const svgMarkupOf = (source: string): string | undefined => {
  const node = svgOf(source)
  return node === undefined ? undefined : new (dom().XMLSerializer)().serializeToString(node)
}
