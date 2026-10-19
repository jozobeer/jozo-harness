import { createUniqueId, type JSX } from 'solid-js'

/** The line icons the page draws itself, so it carries no icon package. */
export type IconName = 'chevron-down' | 'square' | 'check-square'

const SHAPES: Readonly<Record<IconName, (id: string) => JSX.Element>> = {
  'chevron-down': () => <path class="icon-line" d="M3.5 6 8 10.5 12.5 6" />,
  square: () => <rect class="icon-line" x="2.75" y="2.75" width="10.5" height="10.5" rx="2.5" />,
  // The check is cut out of the box, so it shows whatever the box sits on.
  'check-square': (id) => (
    <>
      <mask id={id}>
        <rect width="16" height="16" fill="white" />
        <path
          d="M5 8.2l2 2 4-4.2"
          fill="none"
          stroke="black"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </mask>
      <rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor" mask={`url(#${id})`} />
    </>
  ),
}

/** One icon on a 16px grid, drawn in the colour of the text around it. */
export const Icon = (props: { name: IconName; class?: string }) => {
  const id = createUniqueId()
  return (
    <svg class={'icon ' + (props.class ?? '')} viewBox="0 0 16 16" aria-hidden="true">
      {SHAPES[props.name](id)}
    </svg>
  )
}
