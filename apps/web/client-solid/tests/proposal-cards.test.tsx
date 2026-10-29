import { describe, expect, test } from 'vitest'
import { DEFAULT_PROPOSAL_CARDS, PROPOSAL_CARDS_KEY, proposalCardsFrom } from '../proposal-cards.ts'

describe('the proposal-card choice', () => {
  test('a page with nothing stored draws the cards', () => {
    expect(proposalCardsFrom(null)).toBe('shown')
    expect(DEFAULT_PROPOSAL_CARDS).toBe('shown')
  })

  test('both choices read back as they were stored', () => {
    expect(proposalCardsFrom('shown')).toBe('shown')
    expect(proposalCardsFrom('hidden')).toBe('hidden')
  })

  test('a value the page does not know draws the cards rather than an empty answer', () => {
    expect(proposalCardsFrom('off')).toBe('shown')
    expect(proposalCardsFrom('')).toBe('shown')
  })

  test('the choice is kept under its own key', () => {
    expect(PROPOSAL_CARDS_KEY).toBe('jzh.proposal-cards')
  })
})
