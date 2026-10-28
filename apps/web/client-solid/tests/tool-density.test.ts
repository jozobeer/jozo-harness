import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_DENSITY,
  TOOL_DENSITY_KEY,
  toolDensityFrom,
  type ToolDensity,
} from '../tool-density.ts'

describe('the density the conversation draws tool lines at', () => {
  it('opens at the standard density when the reader has chosen none', () => {
    expect(toolDensityFrom(null)).toBe('standard')
    expect(DEFAULT_TOOL_DENSITY).toBe('standard')
  })

  it('keeps the density the reader chose across a reload', () => {
    const kept: ReadonlyArray<ToolDensity> = ['compact', 'standard', 'detailed', 'verbose']
    for (const density of kept) {
      expect(toolDensityFrom(density)).toBe(density)
    }
  })

  it('reads a stored value it does not name as the standard card', () => {
    expect(toolDensityFrom('tiny')).toBe('standard')
    expect(toolDensityFrom('')).toBe('standard')
  })

  it('keeps the choice under one key', () => {
    expect(TOOL_DENSITY_KEY).toBe('jzh.tool-density')
  })
})
