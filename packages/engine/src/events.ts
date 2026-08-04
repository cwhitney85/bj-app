/**
 * The engine → UI event stream (SPEC §4).
 *
 * Contract: every event carries everything needed to render it. The animation
 * layer must never have to query back into engine state to draw a frame, because
 * it consumes these on its own clock, arbitrarily far behind the logical state.
 */

import type { Card } from './cards.js';
import type { Action } from './hand.js';
import type { HandOutcome } from './settle.js';
import type { Phase } from './state.js';

export type SeatRef = {
  readonly seat: number;
  readonly handIndex: number;
};

export type GameEvent =
  | { readonly type: 'RoundStarted'; readonly roundNumber: number; readonly shoeIndex: number }
  | { readonly type: 'BetPlaced'; readonly seat: number; readonly amount: number; readonly bankroll: number }
  | {
      readonly type: 'CardDealt';
      readonly seat: number | 'dealer';
      readonly handIndex: number;
      readonly card: Card;
      readonly total: number;
      readonly soft: boolean;
      /** Second pass of the initial deal, versus a hit/draw. */
      readonly initialDeal: boolean;
    }
  | { readonly type: 'HoleCardPlaced'; readonly dealerUpcard: Card }
  | { readonly type: 'InsuranceOffered'; readonly seats: readonly number[]; readonly cost: number }
  | { readonly type: 'InsuranceTaken'; readonly seat: number; readonly amount: number; readonly bankroll: number }
  | { readonly type: 'InsuranceDeclined'; readonly seat: number }
  | { readonly type: 'HoleCardRevealed'; readonly card: Card; readonly total: number; readonly dealerBlackjack: boolean }
  /** `wasRecommended` is filled in by the coaching layer (M2); the engine itself
   *  has no opinion about whether an action was correct. */
  | { readonly type: 'PlayerActed'; readonly ref: SeatRef; readonly action: Action; readonly wasRecommended?: boolean }
  | { readonly type: 'HandBusted'; readonly ref: SeatRef; readonly total: number }
  | { readonly type: 'HandStood'; readonly ref: SeatRef; readonly total: number; readonly soft: boolean }
  | { readonly type: 'HandDoubled'; readonly ref: SeatRef; readonly card: Card; readonly total: number; readonly bet: number }
  | { readonly type: 'HandSplit'; readonly ref: SeatRef; readonly newHandIndex: number; readonly bet: number }
  | { readonly type: 'HandSurrendered'; readonly ref: SeatRef }
  | { readonly type: 'TurnStarted'; readonly ref: SeatRef; readonly legalActions: readonly Action[] }
  | { readonly type: 'DealerDrew'; readonly card: Card; readonly total: number; readonly soft: boolean }
  | { readonly type: 'DealerStood'; readonly total: number; readonly soft: boolean }
  | { readonly type: 'DealerBusted'; readonly total: number }
  | {
      readonly type: 'HandSettled';
      readonly ref: SeatRef;
      readonly outcome: HandOutcome;
      readonly bet: number;
      readonly payout: number;
      readonly net: number;
    }
  | {
      readonly type: 'InsuranceSettled';
      readonly seat: number;
      readonly bet: number;
      readonly payout: number;
      readonly net: number;
    }
  | { readonly type: 'BankrollChanged'; readonly seat: number; readonly bankroll: number; readonly delta: number }
  | { readonly type: 'CutCardReached'; readonly shoeIndex: number }
  | { readonly type: 'ShuffleStarted'; readonly seed: number }
  | { readonly type: 'PhaseChanged'; readonly from: Phase; readonly to: Phase };

export type GameEventType = GameEvent['type'];

/** Narrow an event list to one variant — used constantly in tests. */
export function eventsOfType<T extends GameEventType>(
  events: readonly GameEvent[],
  type: T,
): readonly Extract<GameEvent, { type: T }>[] {
  return events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}
