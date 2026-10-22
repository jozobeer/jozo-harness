import { For } from 'solid-js'
import { linkPartsOf } from '../../src/ui/linkify.ts'

/**
 * Plain text with the URLs in it turned into anchors. The text is never parsed
 * as HTML; each run becomes its own node, so only the links our scan accepted
 * can reach the DOM.
 */
export const Linkify = (props: { text: string; stop?: boolean }) => (
  <For each={linkPartsOf(props.text)}>
    {(part) =>
      part.kind === 'text' ? (
        part.text
      ) : (
        <a
          class="auto-link"
          href={part.href}
          title={part.title}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => {
            // A link in a folded line opens the page without folding the card.
            if (props.stop === true) event.stopPropagation()
          }}
        >
          {part.label}
        </a>
      )
    }
  </For>
)
