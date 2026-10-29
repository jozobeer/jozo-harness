import { For, Show } from 'solid-js'
import type { TraceProposal } from '../../src/ui/trace.ts'
import { useTranslate } from '../i18n.ts'
import type { SessionStore } from '../store.ts'
import { Markdown } from './markdown.tsx'
import { LogButton } from './log-button.tsx'
import { Button } from './ui/button.tsx'
import { Icon } from './ui/icon.tsx'

/**
 * One proposal the model put below its answer: the question, the choices it
 * offered, and the choice the reader took. The card never applies anything by
 * itself; a choice becomes the next user message, and choosing another option
 * corrects that message instead of locking the card.
 */
export const ProposalCard = (props: { proposal: TraceProposal; store: SessionStore }) => {
  const t = useTranslate()
  return (
    <article class="block ask proposal-card" data-proposal={props.proposal.id}>
      <header class="proposal-head">
        <Icon name="ask" class="proposal-icon" />
        <strong class="proposal-title">{t('proposal.title')}</strong>
        <LogButton store={props.store} target={{ kind: 'proposal', id: props.proposal.id }} />
      </header>
      <Markdown text={props.proposal.question} class="ask-question" />
      <Show when={props.proposal.options.length > 0}>
        <div class="ask-options">
          <For each={props.proposal.options}>
            {(option) => (
              <Button
                variant={props.proposal.answer === option ? 'foam' : 'rim'}
                type="button"
                data-proposal-option={option}
                aria-pressed={props.proposal.answer === option}
                onClick={() =>
                  props.store.send({ kind: 'answer', id: props.proposal.id, answer: option })
                }
              >
                {option}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.proposal.answer}>
        {(answer) => <p class="ask-answer">{t('proposal.chosen') + answer()}</p>}
      </Show>
    </article>
  )
}
