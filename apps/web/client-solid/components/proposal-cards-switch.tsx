import { For } from 'solid-js'
import { useTranslate } from '../i18n.ts'
import type { MessageKey } from '../locale.ts'
import { PROPOSAL_CARDS, type ProposalCards } from '../proposal-cards.ts'

const LABELS: Readonly<Record<ProposalCards, MessageKey>> = {
  shown: 'proposal.cards.shown',
  hidden: 'proposal.cards.hidden',
}

/** The strip's choice of whether a model's proposal is drawn under the answer. */
export const ProposalCardsSwitch = (props: {
  cards: ProposalCards
  onChoose: (cards: ProposalCards) => void
}) => {
  const t = useTranslate()
  return (
    <label class="proposal-cards">
      <span class="proposal-cards-label">{t('proposal.cards')}</span>
      <select
        class="proposal-cards-select"
        value={props.cards}
        aria-label={t('proposal.cards.group')}
        onChange={(event) => {
          const next = event.currentTarget.value
          const cards = PROPOSAL_CARDS.find((choice) => choice === next)
          if (cards !== undefined) props.onChoose(cards)
        }}
      >
        <For each={PROPOSAL_CARDS}>
          {(cards) => <option value={cards}>{t(LABELS[cards])}</option>}
        </For>
      </select>
    </label>
  )
}
