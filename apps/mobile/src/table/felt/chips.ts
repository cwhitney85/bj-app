/**
 * A bet, as the chips it is actually made of (SPEC §9's "physical chip stacks").
 *
 * SPEC §10 names four denominations and no others: $5, $25, $100, $500. That is
 * an art-pipeline decision, and it has a consequence this module refuses to hide
 * — **not every amount the engine can produce is expressible in them.** Insurance
 * is half a base bet, so a $5 bet insures for $2.50, and nothing is rounded
 * anywhere (M1 decision 3).
 *
 * So `chipsFor` returns what the stack really is *plus* what is left over, and
 * the caller prints the remainder as a number. The alternatives were both worse:
 * rounding would draw chips adding up to a different bet than the one placed,
 * and inventing a $1 chip would put a denomination on the felt that the art
 * direction does not have.
 *
 * **Everything here is integer cents (money.ts), and that is why this file no
 * longer carries a rounding helper.** It used to: money was held in doubles, so
 * `12.5 - 2 * 5` came out as `2.4999999999999996` and every subtraction in the
 * decomposition had to be pushed back onto a cent boundary by hand. That helper
 * was rounding sneaking into the one engine that promised not to round, and it
 * is gone rather than improved — the loop below is exact integer arithmetic and
 * the conservation test now holds by construction rather than by tolerance.
 */

import { DOLLAR, type Cents } from '@bj/engine';

/** A chip's face value, in cents. */
export type ChipDenomination = Cents;

/** Largest first, which is also bottom-of-stack first. */
export const CHIP_DENOMINATIONS: readonly ChipDenomination[] = [
  500 * DOLLAR,
  100 * DOLLAR,
  25 * DOLLAR,
  5 * DOLLAR,
];

/** The smallest chip on this table. Amounts below it have no chip at all. */
export const SMALLEST_CHIP: ChipDenomination = 5 * DOLLAR;

/**
 * Standard casino colours, keyed by face value in cents. Named here rather than
 * in `theme.ts` because they are not the app's palette — they are a fact about
 * what a $25 chip looks like, and a player who has seen a real table knows them.
 */
export const CHIP_COLORS: Record<ChipDenomination, { readonly face: string; readonly edge: string }> = {
  [500 * DOLLAR]: { face: '#5b3a86', edge: '#e6dcf2' },
  [100 * DOLLAR]: { face: '#23272b', edge: '#d6dade' },
  [25 * DOLLAR]: { face: '#1f7a4d', edge: '#dff0e6' },
  [5 * DOLLAR]: { face: '#a8232f', edge: '#f4dcdf' },
};

/** One denomination and how many of it the stack holds. */
export type ChipRun = {
  readonly denomination: ChipDenomination;
  readonly count: number;
};

export type ChipStack = {
  /** Largest denomination first. Denominations with a count of zero are omitted. */
  readonly runs: readonly ChipRun[];
  /**
   * What no chip can express, in cents: always less than the smallest
   * denomination. A caller that ignores this is drawing a stack worth less than
   * the bet.
   */
  readonly remainder: Cents;
};

/**
 * Break an amount into chips, largest denomination first.
 *
 * Precondition (a caller bug, and thrown): `amount` is a non-negative whole
 * number of cents. A negative bet is not a stack of chips owed; a fractional one
 * is money the engine cannot have produced. Settling either silently here would
 * draw a pile where a seat has nothing on the felt.
 *
 * Postconditions, asserted in `test/chips.test.ts`:
 * - the runs sum, with `remainder`, to exactly `amount` — **exactly, not within
 *   a tolerance**, which is what integer cents bought;
 * - `0 <= remainder < SMALLEST_CHIP`;
 * - runs are in strictly descending denomination order and never have a count of
 *   zero;
 * - greedy is minimal here, so no stack is taller than it has to be — every
 *   denomination divides the next one up, which is what makes that true.
 */
export function chipsFor(amount: Cents): ChipStack {
  if (amount < 0) throw new Error(`chipsFor: an amount cannot be negative, got ${amount}`);
  if (!Number.isInteger(amount)) {
    throw new Error(`chipsFor: ${amount} is not a whole number of cents`);
  }

  const runs: ChipRun[] = [];
  let left = amount;

  for (const denomination of CHIP_DENOMINATIONS) {
    const count = Math.floor(left / denomination);
    if (count > 0) {
      runs.push({ denomination, count });
      left -= count * denomination;
    }
  }

  return { runs, remainder: left };
}

/** Total chips in a stack — what the renderer needs to know before it draws one. */
export function chipCount(stack: ChipStack): number {
  return stack.runs.reduce((total, run) => total + run.count, 0);
}
