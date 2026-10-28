/** How much of each tool call the conversation draws on its line and inside the fold. */
export const TOOL_DENSITIES = ['compact', 'standard', 'detailed', 'verbose'] as const

export type ToolDensity = (typeof TOOL_DENSITIES)[number]

/** The card the conversation has always drawn: name, summary, result, and the time taken. */
export const DEFAULT_TOOL_DENSITY: ToolDensity = 'standard'

/** Where the reader's choice is kept between visits. */
export const TOOL_DENSITY_KEY = 'jzh.tool-density'

/** What to make of a stored value: anything the list does not name reads the standard card. */
export const toolDensityFrom = (stored: string | null): ToolDensity =>
  TOOL_DENSITIES.find((density) => density === stored) ?? DEFAULT_TOOL_DENSITY
