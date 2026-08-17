/**
 * Round state shape. Kept in its own module so `round.ts` (transitions),
 * `settle.ts` (payouts) and the bot/coaching layers can all depend on the shape
 * without depending on each other.
 *
 * All state is plain serialisable data: no class instances, no functions, no
 * Date, no references to anything in the host environment. That is what makes
 * golden-seed replay and the counterfactual demo possible.
 */

import type { Card, Shoe } from './cards.js';
import type { Hand } from './hand.js';
import type { Cents } from './money.js';
import type { RuleSet } from './rules.js';

export type Phase =
  | 'idle'
  | 'betting'
  | 'dealing'
  | 'insuranceOffer'
  | 'dealerPeek'
  | 'playerTurn'
  | 'dealerPlay'
  | 'settlement'
  | 'cleanup'
  | 'shuffle';

export type SeatOccupant =
  | { readonly kind: 'empty' }
  | { readonly kind: 'player' }
  | { readonly kind: 'bot'; readonly policyId: string; readonly characterId: string };

export type Seat = {
  readonly index: number;
  readonly occupant: SeatOccupant;
  readonly bankroll: Cents;
  /** The bet placed this round, before any doubling or splitting. In cents. */
  readonly baseBet: Cents;
  readonly hands: readonly Hand[];
  /** Which of `hands` is currently acting, or -1 when the seat is not acting. */
  readonly activeHandIndex: number;
  /** Half the base bet if insurance was taken, else 0. In cents. */
  readonly insuranceBet: Cents;
  /** Set once the seat has answered the insurance offer this round. */
  readonly insuranceResolved: boolean;
};

export type DealerState = {
  readonly cards: readonly Card[];
  readonly holeCardRevealed: boolean;
  /** Set by the peek: known before reveal, but only to the engine. */
  readonly hasBlackjack: boolean;
};

export type RoundState = {
  readonly phase: Phase;
  readonly rules: RuleSet;
  readonly shoe: Shoe;
  readonly seats: readonly Seat[];
  readonly dealer: DealerState;
  /** Seat index whose turn it is during `playerTurn`, else -1. */
  readonly turnSeat: number;
  readonly roundNumber: number;
  /** Seed for the current shoe; reshuffles derive the next one from it. */
  readonly shoeSeed: number;
  /** True once the cut card was passed; the shuffle happens at cleanup. */
  readonly shufflePending: boolean;
};

export function isPlayerSeat(seat: Seat): boolean {
  return seat.occupant.kind === 'player';
}

export function isOccupied(seat: Seat): boolean {
  return seat.occupant.kind !== 'empty';
}

/** Seats in table order that are in the current round (occupied with a bet). */
export function activeSeats(state: RoundState): readonly Seat[] {
  return state.seats.filter((seat) => isOccupied(seat) && seat.hands.length > 0);
}

export function seatAt(state: RoundState, index: number): Seat {
  const seat = state.seats[index];
  if (seat === undefined) throw new Error(`No seat at index ${index}`);
  return seat;
}

export function handAt(seat: Seat, handIndex: number): Hand {
  const hand = seat.hands[handIndex];
  if (hand === undefined) throw new Error(`Seat ${seat.index} has no hand at index ${handIndex}`);
  return hand;
}

export function dealerUpcard(state: RoundState): Card | undefined {
  return state.dealer.cards[0];
}

export function dealerHoleCard(state: RoundState): Card | undefined {
  return state.dealer.cards[1];
}

/** Total currently committed to the table by a seat — bets plus insurance. */
export function committed(seat: Seat): number {
  return seat.hands.reduce((sum, hand) => sum + hand.bet, 0) + seat.insuranceBet;
}
