import { createContext, useContext, type Accessor } from 'solid-js'
import { DEFAULT_PROPOSAL_CARDS, type ProposalCards } from './proposal-cards.ts'

/** What a page tells its parts about drawing a proposal, and how the reader changes it. */
export interface ProposalCardsChoice {
  readonly cards: Accessor<ProposalCards>
  readonly choose: (cards: ProposalCards) => void
}

/** The cards, for a part drawn on its own as a test draws one. */
const defaultChoice: ProposalCardsChoice = {
  cards: () => DEFAULT_PROPOSAL_CARDS,
  choose: () => undefined,
}

export const ProposalCardsContext = createContext<ProposalCardsChoice>(defaultChoice)

export const useProposalCards = (): ProposalCardsChoice =>
  useContext(ProposalCardsContext) ?? defaultChoice
