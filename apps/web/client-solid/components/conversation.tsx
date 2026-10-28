import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { Conversation as ConversationState } from '@jozo-harness/ui-view'
import { followsBottom } from '../../src/ui/scroll.ts'
import type { SessionStore } from '../store.ts'
import { Turns } from './turns.tsx'

const Welcome = () => (
  <section class="welcome">
    <h2>New session</h2>
    <p class="welcome-lead">Nothing has been said yet. Type below and press Enter.</p>
    <ul class="welcome-hints">
      <li>
        <code>/help</code> lists what a session answers; <code>/status</code> says where it stands
      </li>
      <li>a shell command asks before it runs</li>
      <li>
        the sheet on the right carries what the session works toward, its turns, jobs and settings
      </li>
    </ul>
  </section>
)

/** A session nobody has said anything to yet, and nothing waiting for an answer. */
const isEmpty = (conversation: ConversationState): boolean =>
  conversation.blocks.length === 0 &&
  conversation.live === '' &&
  conversation.approval === undefined &&
  conversation.ask === undefined

/**
 * The conversation column. It follows the tail while the reader is at the
 * bottom; reading further up keeps the place it was at.
 */
export const Conversation = (props: { store: SessionStore }) => {
  let element: HTMLElement | undefined
  /** The conversation this column last followed to the bottom. */
  let followed: ConversationState | undefined
  const [atBottom, setAtBottom] = createSignal(true)

  onMount(() => {
    // A selection inside the conversation is what the composer may quote; one
    // elsewhere on the page belongs to another pane and names no turn.
    const report = (): void => {
      const picked = window.getSelection()
      const anchor = picked?.anchorNode ?? null
      const inside = element !== undefined && anchor !== null && element.contains(anchor)
      props.store.setSelection(inside ? (picked?.toString() ?? '') : '')
    }
    document.addEventListener('selectionchange', report)
    onCleanup(() => {
      document.removeEventListener('selectionchange', report)
      props.store.setSelection('')
    })
  })

  createEffect(() => {
    // Reading the conversation is what subscribes this effect to every event.
    const conversation = props.store.state().conversation
    // The effect runs after the blocks land; a reader at the bottom follows them.
    // Only a conversation that changed is worth laying the column out for: reading
    // and writing the height of a long log is work of its own, and a write to any
    // other part of the state, a keystroke included, does not move the tail.
    if (element === undefined || !atBottom() || isEmpty(conversation)) return
    if (conversation === followed) return
    followed = conversation
    element.scrollTop = element.scrollHeight
  })

  return (
    <main
      id="conversation"
      tabindex="0"
      ref={(node) => {
        element = node
        node.addEventListener('scroll', () => setAtBottom(followsBottom(node)))
      }}
    >
      <Show when={!isEmpty(props.store.state().conversation)} fallback={<Welcome />}>
        <Turns store={props.store} />
      </Show>
    </main>
  )
}
