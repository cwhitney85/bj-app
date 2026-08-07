/**
 * What a seat at the table can actually see.
 *
 * This module exists for one reason: a bot policy handed the raw `RoundState`
 * can read `state.dealer.cards[1]` and `state.dealer.hasBlackjack`. Nothing
 * stops it, and nothing in review reliably catches it. A bot that peeks is not
 * a bot — and it destroys the one feature that depends on bots being honest:
 * the third-base counterfactual (SPEC §7) is a claim about what a *bad* player
 * costs you, which means nothing if the bad player is clairvoyant.
 *
 * So the projection is a distinct type with no field capable of carrying a
 * face-down card. Reaching the hole card from a `TableView` is a compile error,
 * not a defect waiting to be noticed.
 *
 * Seats are passed through unchanged: `Seat` holds bankroll, bets and cards,
 * all of which are face up at a real table. The dealer is the only thing with
 * anything to hide, so the dealer is the only thing this censors.
 */

import type { Card } from './cards.js';
import { legalActions, type Action, type Hand, type LegalActionContext } from './hand.js';
import { visibleCards } from './knowledge.js';
import type { RuleSet } from './rules.js';
import { dealerUpcard, handAt, seatAt, type RoundState, type Seat } from './state.js';

/** The public state of the table at a decision point. */
export type TableView = {
  readonly rules: RuleSet;
  readonly roundNumber: number;
  readonly dealerUpcard: Card;
  /**
   * The dealer's face-up cards. Exactly one entry until the hole card is
   * turned; after the reveal, the whole hand including anything drawn.
   */
  readonly dealerCards: readonly Card[];
  readonly holeCardRevealed: boolean;
  readonly seats: readonly Seat[];
  /** Every card face up on the table this round — see `knowledge.ts`. */
  readonly visibleCards: readonly Card[];
  /** How far into the shoe the round is. Public: the discard tray is visible. */
  readonly shoeIndex: number;
};

/** A seat being asked to act on one hand. */
export type ActionView = {
  readonly table: TableView;
  readonly seat: Seat;
  readonly handIndex: number;
  readonly hand: Hand;
  /** Non-empty. The chosen action must be one of these. */
  readonly legalActions: readonly Action[];
  /** Ready to hand to `recommend()` — no caller has to rebuild it. */
  readonly context: LegalActionContext;
};

/** A seat being offered insurance. */
export type InsuranceView = {
  readonly table: TableView;
  readonly seat: Seat;
  /** Stake as a fraction of the base bet — 0.5 under every MVP rule set. */
  readonly cost: number;
};

/**
 * A seat being asked for a bet. There is no `TableView` here because there is
 * no dealer yet: betting happens before a single card is dealt, so a type that
 * promised a `dealerUpcard` would be lying.
 */
export type BetView = {
  readonly rules: RuleSet;
  readonly roundNumber: number;
  readonly seat: Seat;
  readonly shoeIndex: number;
};

/**
 * Project the public table.
 *
 * Precondition: the dealer has an upcard, i.e. the round is past `dealing`.
 * Throws rather than returning an optional upcard, because every caller is at
 * a decision point where the upcard exists and an optional would push a
 * meaningless branch into every policy.
 */
export function tableView(state: RoundState): TableView {
  const upcard = dealerUpcard(state);
  if (upcard === undefined) {
    throw new Error(`tableView: no dealer upcard in phase "${state.phase}"`);
  }
  return {
    rules: state.rules,
    roundNumber: state.roundNumber,
    dealerUpcard: upcard,
    dealerCards: state.dealer.holeCardRevealed ? state.dealer.cards : [upcard],
    holeCardRevealed: state.dealer.holeCardRevealed,
    seats: state.seats,
    visibleCards: visibleCards(state),
    shoeIndex: state.shoe.index,
  };
}

/**
 * The view for the hand a seat is currently acting on.
 *
 * Precondition: the seat has an active hand with at least one legal action.
 * Throws otherwise — a caller asking a seat that is not acting has a bug, and
 * inventing an empty action list would push it downstream into a policy.
 */
export function actionView(state: RoundState, seatIndex: number): ActionView {
  const seat = seatAt(state, seatIndex);
  const handIndex = seat.activeHandIndex;
  if (handIndex < 0) throw new Error(`actionView: seat ${seatIndex} is not acting`);

  const hand = handAt(seat, handIndex);
  const context: LegalActionContext = {
    rules: state.rules,
    handCount: seat.hands.length,
    availableFunds: seat.bankroll,
  };
  const legal = legalActions(hand, context);
  if (legal.length === 0) {
    throw new Error(`actionView: seat ${seatIndex} hand ${handIndex} has no legal actions`);
  }

  return { table: tableView(state), seat, handIndex, hand, legalActions: legal, context };
}

export function insuranceView(state: RoundState, seatIndex: number, cost: number): InsuranceView {
  return { table: tableView(state), seat: seatAt(state, seatIndex), cost };
}

export function betView(state: RoundState, seatIndex: number): BetView {
  return {
    rules: state.rules,
    roundNumber: state.roundNumber,
    seat: seatAt(state, seatIndex),
    shoeIndex: state.shoe.index,
  };
}
