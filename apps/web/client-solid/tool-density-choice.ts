import { createContext, useContext, type Accessor } from 'solid-js'
import { DEFAULT_TOOL_DENSITY, type ToolDensity } from './tool-density.ts'

/** What a page tells its parts about how much of a tool call to draw, and how the reader changes it. */
export interface ToolDensityChoice {
  readonly density: Accessor<ToolDensity>
  readonly choose: (density: ToolDensity) => void
}

/** The standard card, for a part drawn on its own as a test draws one. */
const defaultChoice: ToolDensityChoice = {
  density: () => DEFAULT_TOOL_DENSITY,
  choose: () => undefined,
}

export const ToolDensityContext = createContext<ToolDensityChoice>(defaultChoice)

export const useToolDensity = (): ToolDensityChoice =>
  useContext(ToolDensityContext) ?? defaultChoice
