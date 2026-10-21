import { For, createEffect, onCleanup, onMount } from 'solid-js'
import { LENSES, type Lens } from '../lens.ts'
import { Icon, type IconName } from './ui/icon.tsx'

const LABELS: Readonly<Record<Lens, string>> = { answers: 'Chat', timeline: 'Timeline' }
const ICONS: Readonly<Record<Lens, IconName>> = { answers: 'answers', timeline: 'timeline' }

/** The strip's switch between the two ways the middle column reads a session. */
export const LensSwitch = (props: { lens: Lens; onChoose: (lens: Lens) => void }) => {
  let strip: HTMLDivElement | undefined

  // The labels differ in width, so the pill reads the pressed option's place
  // instead of assuming an equal share of the strip.
  const place = () => {
    const picked = strip?.querySelector<HTMLElement>(`.lens-option[data-lens="${props.lens}"]`)
    if (strip === undefined || picked === null || picked === undefined) return
    strip.style.setProperty('--pick-x', `${picked.offsetLeft}px`)
    strip.style.setProperty('--pick-w', `${picked.offsetWidth}px`)
  }

  createEffect(place)
  onMount(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    if (strip !== undefined) observer.observe(strip)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div
      class="lens"
      role="group"
      aria-label="How the session reads"
      ref={(element) => (strip = element)}
    >
      <For each={LENSES}>
        {(lens) => (
          <button
            class="lens-option"
            type="button"
            data-lens={lens}
            aria-pressed={props.lens === lens}
            onClick={() => props.onChoose(lens)}
          >
            <Icon name={ICONS[lens]} />
            {LABELS[lens]}
          </button>
        )}
      </For>
    </div>
  )
}
