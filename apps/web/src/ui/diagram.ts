/** The largest an SVG fence may be before it stays a code block. */
export const SVG_MAX_BYTES = 100_000

/** How many UTF-8 bytes a string is; the limit counts bytes, not characters. */
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/** Base64 of a string's UTF-8 bytes, which is what a data URL carries. */
const base64Of = (text: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * A data URL for an SVG fence, or nothing when the fence is empty or too big to
 * draw. The SVG never enters the page as markup: the browser decodes it into an
 * <img>, where scripts and event handlers do not run.
 */
export const svgDataUrl = (svg: string): string | undefined => {
  const body = svg.trim()
  if (body === '' || bytesOf(body) > SVG_MAX_BYTES) return undefined
  return 'data:image/svg+xml;base64,' + base64Of(body)
}

const IMAGE_SRC = /^https?:\/\/\S+$/i

/** The src a markdown image may take; only http(s) is drawn, so a data: URL stays text. */
export const imageSrcOf = (url: string): string | undefined =>
  IMAGE_SRC.test(url) ? url : undefined
