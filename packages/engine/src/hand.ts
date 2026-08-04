/**
 * Hand evaluation and legal-action derivation.
 *
 * Everything here is a pure function of cards + rule set. `legalActions` is the
 * single source of truth for what a seat may do; the state machine accepts an
 * action only if it appears in this list, which is what makes the "no illegal
 * action is ever accepted" invariant (SPEC §8) testable in one place.
 */

import { cardValue, type Card } from './cards.js';
import type { RuleSet } from './rules.js';

export type Action = 'hit' | 'stand' | 'double' | 'split' | 'surrender';

export type HandTotal = {
  /** Best total not exceeding 21, or the busted hard total. */
  readonly total: number;
  /** True when an ace is still counted as 11. */
  readonly soft: boolean;
};

/**
 * Total a set of cards, demoting aces from 11 to 1 only as far as needed.
 * Counting every ace high first and demoting is equivalent to, and cheaper
 * than, enumerating ace assignments.
 */
export function handTotal(cards: readonly Card[]): HandTotal {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const value = cardValue(card.rank);
    total += value;
    if (card.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

export function isBust(cards: readonly Card[]): boolean {
  return handTotal(cards).total > 21;
}

/**
 * A natural: 21 on the first two cards. A hand created by splitting can never
 * be a natural, so 21 on a split ace pays even money (SPEC §2).
 */
export function isBlackjack(cards: readonly Card[], fromSplit = false): boolean {
  return !fromSplit && cards.length === 2 && handTotal(cards).total === 21;
}

/** Two cards of equal value. K+Q is a splittable pair at Vegas Strip rules. */
export function isPair(cards: readonly Card[]): boolean {
  if (cards.length !== 2) return false;
  const [a, b] = cards;
  if (a === undefined || b === undefined) return false;
  return cardValue(a.rank) === cardValue(b.rank);
}

export function isPairOfAces(cards: readonly Card[]): boolean {
  return isPair(cards) && cards[0]?.rank === 'A';
}

// --- Hands in play ---------------------------------------------------------

export type Hand = {
  readonly cards: readonly Card[];
  readonly bet: number;
  /** This hand was produced by splitting, so it can never be a natural. */
  readonly fromSplit: boolean;
  /** Produced by splitting aces: one card only, no further action. */
  readonly fromSplitAces: boolean;
  readonly doubled: boolean;
  readonly stood: boolean;
  readonly surrendered: boolean;
};

export function createHand(cards: readonly Card[], bet: number): Hand {
  return {
    cards,
    bet,
    fromSplit: false,
    fromSplitAces: false,
    doubled: false,
    stood: false,
    surrendered: false,
  };
}

/** The hand can take no further action, whether or not it has been settled. */
export function isResolved(hand: Hand): boolean {
  return (
    hand.stood ||
    hand.surrendered ||
    hand.doubled ||
    isBust(hand.cards) ||
    isBlackjack(hand.cards, hand.fromSplit) ||
    handTotal(hand.cards).total === 21 ||
    isSplitAceComplete(hand)
  );
}

/** A split ace that has received its one card is finished by rule, not choice. */
function isSplitAceComplete(hand: Hand): boolean {
  return hand.fromSplitAces && hand.cards.length >= 2;
}

export type LegalActionContext = {
  readonly rules: RuleSet;
  /** How many hands this seat currently holds, for the resplit limit. */
  readonly handCount: number;
  /** Bankroll available beyond the bets already committed this round. */
  readonly availableFunds: number;
};

/**
 * Every action the hand may legally take, in a stable order.
 *
 * Note: hitting a hard 21 is legal in a casino but is never correct and only
 * ever a misclick, so it is excluded here. That keeps `isResolved` and this
 * function in agreement and gives the state machine a clean invariant.
 */
export function legalActions(hand: Hand, context: LegalActionContext): readonly Action[] {
  // A hand mid-deal cannot act. This matters for a freshly split hand, which
  // holds one card until its turn comes round: without this guard it would
  // offer stand/hit before its mandatory second card arrived.
  if (hand.cards.length < 2) return [];
  if (isResolved(hand)) return [];

  const { rules, handCount, availableFunds } = context;
  const actions: Action[] = ['stand'];
  const { total } = handTotal(hand.cards);
  const isFirstDecision = hand.cards.length === 2;

  if (total < 21) actions.push('hit');

  const canAffordMatchingBet = availableFunds >= hand.bet;

  if (
    isFirstDecision &&
    canAffordMatchingBet &&
    (!hand.fromSplit || rules.doubleAfterSplit) &&
    (rules.doubleTotals === undefined || rules.doubleTotals.includes(total))
  ) {
    actions.push('double');
  }

  if (
    isFirstDecision &&
    isPair(hand.cards) &&
    canAffordMatchingBet &&
    handCount < rules.maxHands &&
    (!isPairOfAces(hand.cards) || !hand.fromSplit || rules.resplitAces)
  ) {
    actions.push('split');
  }

  if (rules.surrender && isFirstDecision && !hand.fromSplit) {
    actions.push('surrender');
  }

  return actions;
}

export function isLegalAction(hand: Hand, action: Action, context: LegalActionContext): boolean {
  return legalActions(hand, context).includes(action);
}

// --- Dealer ----------------------------------------------------------------

/** Dealer draws to 17, standing on soft 17 unless the rule set says otherwise. */
export function dealerShouldHit(cards: readonly Card[], rules: RuleSet): boolean {
  const { total, soft } = handTotal(cards);
  if (total < 17) return true;
  return total === 17 && soft && rules.dealerHitsSoft17;
}
