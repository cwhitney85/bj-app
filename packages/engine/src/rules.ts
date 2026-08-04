/**
 * Rule sets. The MVP ships exactly one (SPEC §2), but every rule the dealing
 * logic and the strategy chart both depend on lives here rather than inline,
 * because basic strategy is only correct relative to a rule set — the two must
 * never drift apart.
 */

export type RuleSet = {
  readonly id: string;
  readonly label: string;
  readonly deckCount: number;
  /** Fraction of the shoe dealt before the cut card. */
  readonly penetration: number;
  /** false = dealer stands on soft 17 (S17). */
  readonly dealerHitsSoft17: boolean;
  /** Payout numerator/denominator for a natural, e.g. 3:2. */
  readonly blackjackPayout: readonly [number, number];
  /** Dealer checks for blackjack immediately on an ace or ten upcard. */
  readonly dealerPeeks: boolean;
  readonly doubleAfterSplit: boolean;
  /** Ranks on which doubling is permitted; undefined = any first two cards. */
  readonly doubleTotals?: readonly number[];
  /** Maximum hands a seat may hold after splitting. 4 = split up to 3 times. */
  readonly maxHands: number;
  readonly resplitAces: boolean;
  /**
   * Split aces receive exactly one card each and may not be hit further.
   * Enforced at split time in `round.ts`, which stamps `fromSplitAces` onto the
   * resulting hands; `hand.ts` then keys off that per-hand flag rather than
   * re-reading the rule set, so a hand always knows its own terms.
   */
  readonly oneCardToSplitAces: boolean;
  readonly surrender: boolean;
  readonly insuranceOffered: boolean;
  /** Insurance pays 2:1 on a half-bet stake. */
  readonly insurancePayout: readonly [number, number];
  readonly minBet: number;
  readonly maxBet: number;
  readonly seatCount: number;
};

export const VEGAS_STRIP: RuleSet = {
  id: 'vegas-strip',
  label: 'Vegas Strip',
  deckCount: 6,
  penetration: 0.75,
  dealerHitsSoft17: false,
  blackjackPayout: [3, 2],
  dealerPeeks: true,
  doubleAfterSplit: true,
  maxHands: 4,
  resplitAces: false,
  oneCardToSplitAces: true,
  surrender: false,
  insuranceOffered: true,
  insurancePayout: [2, 1],
  minBet: 5,
  maxBet: 500,
  seatCount: 7,
};

/** House edge with perfect basic strategy under VEGAS_STRIP. Asserted by the
 *  simulation harness (SPEC §8) — if this drifts, something upstream is wrong. */
export const EXPECTED_HOUSE_EDGE = { min: 0.0035, max: 0.0055 } as const;
