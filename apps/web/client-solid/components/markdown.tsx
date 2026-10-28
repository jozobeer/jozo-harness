import { createEffect, createMemo } from 'solid-js'
import { plainText } from '@jozo-harness/ui-view'
import { renderMarkdown } from '../../src/ui/markdown.ts'

/**
 * The answer as HTML. A text that renders where it did leaves the nodes it
 * already wrote alone, so only a change to the answer rebuilds its body.
 */
export const Markdown = (props: { text: string; class?: string }) => {
  let node: HTMLDivElement | undefined
  let written = ''
  const html = createMemo(() => renderMarkdown(plainText(props.text)))
  createEffect(() => {
    const next = html()
    if (node === undefined || next === written) return
    written = next
    node.innerHTML = next
  })
  return (
    <div
      class={'markdown ' + (props.class ?? '')}
      ref={(element) => {
        node = element
      }}
    />
  )
}
