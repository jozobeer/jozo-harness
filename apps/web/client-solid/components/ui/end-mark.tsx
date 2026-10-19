import { Icon, type IconName } from './icon.tsx'

/** A run that went wrong or was stopped reads as failed; any other end, as done. */
const shapeOf = (outcome: string | undefined): IconName => {
  if (outcome === undefined) return 'idle'
  return outcome === 'error' || outcome === 'cancelled' ? 'failed' : 'done'
}

/**
 * How a piece of work ended, as a line mark: a check, green while the reader has
 * not seen it; a cross in red; a quiet ring for work that has not ended yet.
 */
export const EndMark = (props: { outcome: string | undefined; fresh: boolean; class?: string }) => {
  const shape = (): IconName => shapeOf(props.outcome)
  const fresh = (): string => (props.fresh && shape() === 'done' ? ' fresh' : '')
  return (
    <Icon
      name={shape()}
      class={'end-mark ' + shape() + fresh() + (props.class === undefined ? '' : ' ' + props.class)}
    />
  )
}
