/**
 * Payout math (SPEC §2).
 *
 * Settlement lives apart from the state machine because it is the one part of
 * the engine whose correctness is checkable as pure arithmetic: given a hand,
 * the dealer's cards and a rule set, the money owed has no dependence on phase,
 * turn order or history. That is what lets the settlement tests (SPEC §8) cover
 * every payout case exhaustively without ever constructing a round.
 *
 * The money model is fixed by the state machine and every number here follows
 * from it: bets are deducted from the bankroll at the moment they are placed, so
 * settlement reports `payout` — stake plus profit, credited back — rather than a
 * net delta. A losing hand pays 0 because its stake is already gone. `net` is
 * carried alongside only for the report card and event stream; it is always
 * `payout - bet` and never the thing the bankroll is updated with.
 *
 * Nothing is rounded. A $5 bet at 3:2 returns $12.50, and silently rounding that
 * down would bake a fake edge into an app whose entire purpose is teaching the
 * real one.
 *
 * **Every amount here is an integer number of cents, and that is what makes the
 * previous paragraph true rather than aspirational.** The first implementation
 * held money in doubles, where `12.5 - 2 * 5` is `2.4999999999999996` — so
 * "nothing is rounded" was honoured by the arithmetic and then quietly broken by
 * the representation. See money.ts.
 *
 * Two payouts here halve the stake — surrender, and a natural at 3:2 — and they
 * are the entire reason `PLAYABLE_BET` exists. `validateBet` refuses an odd
 * stake, so `returnAt` and the surrender branch cannot produce a fraction of a
 * cent. That is a precondition owed by the caller and enforced at the door, not
 * a rounding decision taken here.
 */

import type { Card } from './cards.js';
import type { Cents } from './money.js';
import { handTotal, isBlackjack, isBust, type Hand } from './hand.js';
import type { RuleSet } from './rules.js';
import { activeSeats, type RoundState, type Seat } from './state.js';

export type HandOutcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust' | 'surrender';

export type HandSettlement = {
  readonly seat: number;
  readonly handIndex: number;
  readonly outcome: HandOutcome;
  /** Total wagered on this hand, including the doubled portion. In cents. */
  readonly bet: Cents;
  /** Returned to the bankroll: stake plus profit. 0 when the hand lost. */
  readonly payout: Cents;
  readonly net: Cents;
};

export type InsuranceSettlement = {
  readonly seat: number;
  readonly bet: Cents;
  readonly payout: Cents;
  readonly net: Cents;
};

export type RoundSettlement = {
  readonly hands: readonly HandSettlement[];
  readonly insurance: readonly InsuranceSettlement[];
};

/**
 * Stake plus profit at `num:den` odds — what a winning bet returns.
 *
 * Precondition: `den` divides `stake * num` exactly. `PLAYABLE_BET` guarantees
 * it for both ratios this engine ships (3:2 on an even stake, 2:1 on anything).
 * Asserted rather than rounded: a fractional cent here means either a bet got
 * past `validateBet` or a rule set declared a ratio nobody re-derived
 * `PLAYABLE_BET` against — a 6:5 natural being the obvious candidate. Both are
 * bugs upstream of this line, and rounding would hide them behind a house edge
 * that is wrong in the fourth decimal place.
 */
function returnAt(stake: Cents, odds: readonly [number, number]): Cents {
  const [num, den] = odds;
  const profit = (stake * num) / den;
  if (!Number.isInteger(profit)) {
    throw new Error(`returnAt: ${num}:${den} on a stake of ${stake} pays a fraction of a cent`);
  }
  return stake + profit;
}

/**
 * Settle one hand against the dealer's final hand.
 *
 * `dealerHasBlackjack` is passed in rather than derived because under a no-peek
 * rule set the dealer's two cards are not the whole story: the engine knows
 * whether the natural was established before the player acted, and that is what
 * decides whether a doubled or split stake is at risk.
 */
export function settleHand(
  hand: Hand,
  dealerCards: readonly Card[],
  dealerHasBlackjack: boolean,
  rules: RuleSet,
  seat: number,
  handIndex: number,
): HandSettlement {
  const settled = (outcome: HandOutcome, payout: Cents): HandSettlement => ({
    seat,
    handIndex,
    outcome,
    bet: hand.bet,
    payout,
    net: payout - hand.bet,
  });

  // Surrender resolves before the dealer draws, so the dealer's total is
  // irrelevant to it — half the stake comes back whatever happens next.
  if (hand.surrendered) return settled('surrender', hand.bet / 2);

  // A bust loses even when the dealer busts too. That asymmetry is the house
  // edge; without it the game is roughly break-even.
  if (isBust(hand.cards)) return settled('bust', 0);

  // A hand created by splitting can never be a natural, so 21 on a split ace
  // wins even money rather than 3:2 (SPEC §2).
  if (isBlackjack(hand.cards, hand.fromSplit)) {
    return dealerHasBlackjack
      ? settled('push', hand.bet)
      : settled('blackjack', returnAt(hand.bet, rules.blackjackPayout));
  }

  if (dealerHasBlackjack) return settled('lose', 0);

  const dealerTotal = handTotal(dealerCards).total;
  if (dealerTotal > 21) return settled('win', hand.bet * 2);

  const playerTotal = handTotal(hand.cards).total;
  if (playerTotal > dealerTotal) return settled('win', hand.bet * 2);
  if (playerTotal === dealerTotal) return settled('push', hand.bet);
  return settled('lose', 0);
}

/**
 * Settle a seat's insurance side bet, or `undefined` when none was taken.
 *
 * Insurance is a separate wager on a separate proposition, which is why it
 * settles independently of the hand it sits beside: a seat can lose the hand and
 * win the insurance in the same breath.
 */
export function settleInsurance(
  seat: Seat,
  dealerHasBlackjack: boolean,
  rules: RuleSet,
): InsuranceSettlement | undefined {
  const bet = seat.insuranceBet;
  if (bet <= 0) return undefined;

  const payout = dealerHasBlackjack ? returnAt(bet, rules.insurancePayout) : 0;
  return { seat: seat.index, bet, payout, net: payout - bet };
}

/**
 * Settle every hand of every seat in the round, table order, hand order within
 * a seat. That ordering is the same one the UI animates in, so the event stream
 * built from this list needs no re-sorting.
 */
export function settleRound(state: RoundState): RoundSettlement {
  const { dealer, rules } = state;

  // The peek only sets `hasBlackjack` when the upcard warranted a peek, so a
  // no-peek rule set leaves it false until the reveal. Reading the cards as well
  // makes settlement correct under either.
  const dealerHasBlackjack = dealer.hasBlackjack || isBlackjack(dealer.cards);

  const hands: HandSettlement[] = [];
  const insurance: InsuranceSettlement[] = [];

  for (const seat of activeSeats(state)) {
    const insuranceSettlement = settleInsurance(seat, dealerHasBlackjack, rules);
    if (insuranceSettlement !== undefined) insurance.push(insuranceSettlement);

    seat.hands.forEach((hand, handIndex) => {
      hands.push(settleHand(hand, dealer.cards, dealerHasBlackjack, rules, seat.index, handIndex));
    });
  }

  return { hands, insurance };
}
