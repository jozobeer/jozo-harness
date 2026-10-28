import { For } from 'solid-js'
import { useTranslate } from '../i18n.ts'
import type { MessageKey } from '../locale.ts'
import { TOOL_DENSITIES, type ToolDensity } from '../tool-density.ts'

const LABELS: Readonly<Record<ToolDensity, MessageKey>> = {
  compact: 'density.compact',
  standard: 'density.standard',
  detailed: 'density.detailed',
  verbose: 'density.verbose',
}

/** The strip's choice of how much of each tool call the conversation draws. */
export const ToolDensitySwitch = (props: {
  density: ToolDensity
  onChoose: (density: ToolDensity) => void
}) => {
  const t = useTranslate()
  return (
    <label class="density">
      <span class="density-label">{t('density.label')}</span>
      <select
        class="density-select"
        value={props.density}
        aria-label={t('density.group')}
        onChange={(event) => {
          const next = event.currentTarget.value
          const density = TOOL_DENSITIES.find((choice) => choice === next)
          if (density !== undefined) props.onChoose(density)
        }}
      >
        <For each={TOOL_DENSITIES}>
          {(density) => <option value={density}>{t(LABELS[density])}</option>}
        </For>
      </select>
    </label>
  )
}
