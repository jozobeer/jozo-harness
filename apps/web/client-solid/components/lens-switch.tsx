import { For } from 'solid-js'
import { LENSES, type Lens } from '../lens.ts'
import { Icon, type IconName } from './ui/icon.tsx'

const LABELS: Readonly<Record<Lens, string>> = { answers: 'Answers', timeline: 'Timeline' }
const ICONS: Readonly<Record<Lens, IconName>> = { answers: 'answers', timeline: 'timeline' }

/** The strip's switch between the two ways the middle column reads a session. */
export const LensSwitch = (props: { lens: Lens; onChoose: (lens: Lens) => void }) => (
  <div class="lens" role="group" aria-label="How the session reads">
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
