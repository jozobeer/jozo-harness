/** How the conversation answers a model's question with choices. */
export const PROPOSAL_CARDS = ['shown', 'hidden'] as const

export type ProposalCards = (typeof PROPOSAL_CARDS)[number]

/** A page opens with the cards drawn: the model asked for a decision, so it is shown. */
export const DEFAULT_PROPOSAL_CARDS: ProposalCards = 'shown'

/** Where the reader's choice is kept between visits. */
export const PROPOSAL_CARDS_KEY = 'jzh.proposal-cards'

/** What to make of a stored value: anything the list does not name keeps the cards. */
export const proposalCardsFrom = (stored: string | null): ProposalCards =>
  PROPOSAL_CARDS.find((choice) => choice === stored) ?? DEFAULT_PROPOSAL_CARDS
