/**
 * The faces and the base size a reader may set the page in. The sheet's own
 * look is the default, so a page nobody has told otherwise reads as before.
 */

/** The faces the page offers; code keeps its own mono face whatever is chosen. */
export const FONT_FAMILIES = ['sans', 'serif', 'mono'] as const

export type FontFamily = (typeof FONT_FAMILIES)[number]

/** What the page is set in before the reader says otherwise: the sheet's sans. */
export const DEFAULT_FONT_FAMILY: FontFamily = 'sans'

/** The sizes the page offers, in px. The sheet's scale steps around 14. */
export const FONT_SIZES = [12, 13, 14, 15, 16, 18] as const

export type FontSize = (typeof FONT_SIZES)[number]

/** The body size the sheet was drawn for. */
export const DEFAULT_FONT_SIZE: FontSize = 14

/** Where the reader's choices are kept between visits. */
export const FONT_FAMILY_KEY = 'jzh.font.family'
export const FONT_SIZE_KEY = 'jzh.font.size'

/** What to make of a stored family: anything the list does not name is the default. */
export const fontFamilyFrom = (stored: string | null): FontFamily =>
  FONT_FAMILIES.find((family) => family === stored) ?? DEFAULT_FONT_FAMILY

/** What to make of a stored size: anything the list does not name is the default. */
export const fontSizeFrom = (stored: string | null): FontSize =>
  FONT_SIZES.find((size) => String(size) === stored) ?? DEFAULT_FONT_SIZE

/**
 * The token each family stands for. The sheet names its stacks, so the page
 * passes a reference rather than a copy and the stylesheet stays the one place
 * a face is spelled out.
 */
export const familyStack = (family: FontFamily): string => 'var(--' + family + ')'

/**
 * The factor the sheet's type scale is multiplied by. Keeping the scale in one
 * unitless number lets every step grow with the reader's choice, rather than
 * only the body that happens to be set as `--text-base`.
 */
export const fontSizeScale = (size: FontSize): string => String(size / DEFAULT_FONT_SIZE)
