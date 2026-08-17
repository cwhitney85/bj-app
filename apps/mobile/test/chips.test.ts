/**
 * The chip decomposition's contract (SPEC §9's chip stacks, SPEC §10's four
 * denominations).
 *
 * The load-bearing property is conservation: **the chips on the felt plus the
 * remainder are exactly the bet.** A stack that draws to a different number than
 * the one the engine settled is the felt lying about money, which is the one
 * thing this app cannot do (explain.ts decision 15) — and it is invisible,
 * because a pile of chips that is one chip short still looks like a pile.
 *
 * **Every amount here is integer cents (money.ts), and the conservation test is
 * where that shows.** It used to assert `toBeCloseTo`, because money was held in
 * doubles and `chipsFor` had to push each subtraction back onto a cent boundary
 * by hand. It now asserts `toBe`. A tolerance on a money identity is a tolerance
 * on whether the app is telling the truth about a bet, and there is no longer any
 * reason to grant one.
 */

import { describe, expect, it } from 'vitest';
import { DOLLAR } from '@bj/engine';

import { chipCount, chipsFor, CHIP_DENOMINATIONS, SMALLEST_CHIP } from '../src/table/felt/chips';

/** Written as dollars × `DOLLAR` so the intent stays readable at a glance. */
const AMOUNTS = [
  0,
  5 * DOLLAR,
  10 * DOLLAR,
  25 * DOLLAR,
  30 * DOLLAR,
  50 * DOLLAR,
  100 * DOLLAR,
  125 * DOLLAR,
  500 * DOLLAR,
  505 * DOLLAR,
  625 * DOLLAR,
  1000 * DOLLAR,
  // Halves. Insurance is half a base bet, so odd multiples of $5 make cents.
  250,
  750,
  1250,
  6250,
  25_050,
];

describe('chipsFor', () => {
  it('conserves the amount exactly: chips + remainder === the bet', () => {
    for (const amount of AMOUNTS) {
      const { runs, remainder } = chipsFor(amount);
      const total = runs.reduce((sum, run) => sum + run.denomination * run.count, 0);
      // `toBe`, not `toBeCloseTo`. Integer cents is what makes that available,
      // and a money identity should not be graded on a curve.
      expect(total + remainder, `${amount}¢`).toBe(amount);
    }
  });

  it('leaves only what no chip can express', () => {
    for (const amount of AMOUNTS) {
      const { remainder } = chipsFor(amount);
      expect(remainder).toBeGreaterThanOrEqual(0);
      expect(remainder, `${amount}¢`).toBeLessThan(SMALLEST_CHIP);
    }
  });

  it('stacks largest first and never draws an empty run', () => {
    for (const amount of AMOUNTS) {
      const { runs } = chipsFor(amount);
      for (const run of runs) {
        expect(run.count).toBeGreaterThan(0);
        expect(CHIP_DENOMINATIONS).toContain(run.denomination);
      }
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i]!.denomination).toBeLessThan(runs[i - 1]!.denomination);
      }
    }
  });

  it('uses the fewest chips possible', () => {
    // Greedy is minimal because every denomination divides the next one up.
    // Checked against exhaustive search rather than asserted, because that
    // divisibility is a fact about SPEC §10's list and would stop holding the
    // day a $50 chip is added.
    for (const amount of AMOUNTS) {
      const stack = chipsFor(amount);
      if (stack.remainder > 0) continue;
      expect(chipCount(stack), `${amount}¢`).toBe(fewestChips(amount));
    }
  });

  it('draws a whole bet with no remainder, at every stake this table allows', () => {
    // Every legal bet is a multiple of $5 ($5 minimum, $5 increments), so a bet
    // always draws as chips alone. Only payouts and insurance make cents.
    for (let bet = 5 * DOLLAR; bet <= 500 * DOLLAR; bet += 5 * DOLLAR) {
      expect(chipsFor(bet).remainder, `${bet}¢`).toBe(0);
    }
  });

  it('expresses an insurance half-bet as its remainder rather than rounding it', () => {
    // $5 insures for $2.50, and there is no $2.50 chip. Rounding it either way
    // would draw a stack worth a different bet than the one placed.
    expect(chipsFor(250)).toEqual({ runs: [], remainder: 250 });
    expect(chipsFor(1250)).toEqual({
      runs: [{ denomination: 5 * DOLLAR, count: 2 }],
      remainder: 250,
    });
  });

  it('has nothing to draw for a seat that is sitting out', () => {
    expect(chipsFor(0)).toEqual({ runs: [], remainder: 0 });
  });

  it('refuses a negative amount rather than drawing a pile', () => {
    expect(() => chipsFor(-5 * DOLLAR)).toThrow(/cannot be negative/);
  });

  it('refuses a fractional cent, which the engine cannot have produced', () => {
    // The precondition money.ts establishes upstream: every settled amount is a
    // whole number of cents. A fraction reaching the felt means it came from
    // somewhere other than the engine.
    expect(() => chipsFor(12.5)).toThrow(/whole number of cents/);
  });
});

/** Exhaustive minimum, for the greedy check. */
function fewestChips(amount: number): number {
  const best = new Array<number>(amount + 1).fill(Infinity);
  best[0] = 0;
  for (let value = 1; value <= amount; value++) {
    for (const denomination of CHIP_DENOMINATIONS) {
      if (value >= denomination && best[value - denomination]! + 1 < best[value]!) {
        best[value] = best[value - denomination]! + 1;
      }
    }
  }
  return best[amount]!;
}
