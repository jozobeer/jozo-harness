import { Show, createUniqueId, type JSX } from 'solid-js'
import { pourFrom } from '../../pour.ts'

/** The mug, its handle and the head of foam it wears once full, on a 16px grid. */
const MUG = 'M3.5 5h7v7.5a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5z'
const HANDLE = 'M10.5 7h1.3a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-1.3'
const FOAM =
  'M2.8 6.6c-.3-1.3.7-2.5 2-2.3.5-1 1.6-1.4 2.6-1 .8-.8 2.2-.6 2.7.4 1.1.2 1.6 1.3 1.1 2.3l-.2.6H3z'
// A wave eight units long, drawn long enough to roll one whole wavelength across the mug.
const WAVE = 'M-6 5q2-1.5 4 0t4 0t4 0t4 0t4 0t4 0t4 0'

/**
 * Work in progress fills a mug; what waits on the reader is the same mug, full
 * and wearing foam; work that is held is the mug left empty. A filling mug that
 * knows when its work began rises with the time it has run; one that does not
 * stays half full.
 */
export type MugProps =
  | { readonly state: 'filling'; readonly since?: number }
  | { readonly state: 'full' }
  | { readonly state: 'empty' }

export const Mug = (props: MugProps) => {
  const clip = createUniqueId()
  const since = (): number | undefined => (props.state === 'filling' ? props.since : undefined)
  const style = (): JSX.CSSProperties => {
    const from = since()
    return from === undefined ? {} : { '--pour-from': pourFrom(from, Date.now()) }
  }
  return (
    <svg
      class={'mug ' + props.state + (since() === undefined ? '' : ' rising')}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={style()}
    >
      <clipPath id={clip}>
        <path d={MUG} />
      </clipPath>
      <g
        clip-path={'url(#' + clip + ')'}
        visibility={props.state === 'empty' ? 'hidden' : undefined}
      >
        <g class="mug-level">
          <g class="mug-wave">
            <path class="mug-beer" d={WAVE + 'V17H-6z'} />
            <path class="mug-surface" d={WAVE} />
          </g>
        </g>
        <Show when={props.state === 'full'}>
          <circle class="mug-bubble" cx="6" cy="11.5" r=".55" />
          <circle class="mug-bubble" cx="8" cy="9.5" r=".45" />
        </Show>
      </g>
      <path class="mug-outline" d={MUG + HANDLE} />
      <Show when={props.state === 'full'}>
        <path class="mug-foam" d={FOAM} />
      </Show>
    </svg>
  )
}
