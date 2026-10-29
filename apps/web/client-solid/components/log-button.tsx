import { Show } from 'solid-js'
import { seqOfCall, seqOfProposal } from '../../src/ui/log.ts'
import { useTranslate } from '../i18n.ts'
import type { SessionStore } from '../store.ts'
import { Icon } from './ui/icon.tsx'

/**
 * The conversation node a reader wants the log of: a call's card, or the offer
 * a proposal card drew. A call is named by the id the log wrote; a proposal by
 * the id the host gave the question.
 */
export type LogTarget =
  | { readonly kind: 'call'; readonly id: string }
  | { readonly kind: 'proposal'; readonly id: string }

/**
 * The way from a conversation node to the log event it grew. The button appears
 * once the event is in the page's log, so a node still waiting on its history
 * shows no dead control. Pressing it opens the log pane on that event and does
 * nothing else: the conversation, the log, and the model are left as they were.
 */
export const LogButton = (props: { store: SessionStore; target: LogTarget }) => {
  const t = useTranslate()
  const seq = (): number | undefined => {
    const log = props.store.state().log
    return props.target.kind === 'call'
      ? seqOfCall(log, props.target.id)
      : seqOfProposal(log, props.target.id)
  }
  return (
    <Show when={seq()}>
      {(at) => (
        <button
          class="log-mark"
          type="button"
          aria-label={t('log.open')}
          title={t('log.open')}
          onClick={(event) => {
            // A tool's name sits inside the fold's summary; the log must not open the fold.
            event.preventDefault()
            event.stopPropagation()
            props.store.showPane({ kind: 'log', seq: at() })
          }}
        >
          <Icon name="log" />
        </button>
      )}
    </Show>
  )
}
