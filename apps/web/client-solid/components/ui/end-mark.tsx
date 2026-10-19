import { Icon, type IconName } from './icon.tsx'

/**
 * Only a turn that answered reads as done. An error, a stop by hand, the token
 * cap, and a run that died inside the turn all ended short, so they read as
 * failed; a mark that said done for them would be the one lie the row can tell.
 */
const shapeOf = (outcome: string | undefined): IconName => {
  if (outcome === undefined) return 'idle'
  return outcome === 'completed' ? 'done' : 'failed'
}

/**
 * How a piece of work ended: a dot, green while the reader has not seen it and
 * quiet once they have; a red dot when it failed; a ring for work with no end yet.
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
