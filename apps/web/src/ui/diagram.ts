/** The largest a base64 image data URL may be before the image becomes a link. */
export const IMAGE_DATA_MAX_BYTES = 2_000_000

const IMAGE_URL = /^https?:\/\/\S+$/i

/** The four raster types a data URL may carry; svg has its own fence and raw-tag paths. */
const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,/i

/** How a markdown image is shown: drawn as a picture, or linked when it is too large to inline. */
export type ImageView =
  | { readonly kind: 'draw'; readonly src: string }
  | { readonly kind: 'link'; readonly href: string }

/** How many UTF-8 bytes a string is; the limit counts the data URL as written. */
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/**
 * How an image source may render. http(s) URLs and the raster data URLs are
 * drawn; a data URL past the limit is linked so the page does not carry it
 * inline, and every other scheme stays literal text.
 */
export const imageViewOf = (url: string): ImageView | undefined => {
  if (IMAGE_URL.test(url)) return { kind: 'draw', src: url }
  if (!IMAGE_DATA.test(url)) return undefined
  return bytesOf(url) > IMAGE_DATA_MAX_BYTES
    ? { kind: 'link', href: url }
    : { kind: 'draw', src: url }
}
