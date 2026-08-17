/**
 * The chip decomposition's contract (SPEC §9's chip stacks, §10's four
 * denominations).
 *
 * The load-bearing property is conservation: **the chips on the felt plus the
 * remainder are exactly the bet.** A stack that draws to a different number than
 * the one the engine settled is the felt lying about money, which is the one
 * thing this app cannot do (explain.ts decision 15) — and it is invisible,
 * because a pile of chips that is one chip short still looks like a pile of
 * chips.
 */

import { describe, expect, it } from 'vitest';

import { chipCount, chipsFor, CHIP_DENOMINATIONS } from '../src/table/felt/chips';

const SMALLEST = 5;

/** Every amount this table can actually put on the felt, and then some. */
const AMOUNTS = [
  0, 5, 10, 25, 30, 50, 100, 125, 500, 505, 625, 1000,
  // Halves. Insurance is half a base bet, so odd multiples of 5 make cents.
  2.5, 7.5, 12.5, 62.5, 250.5,
];

describe('chipsFor', () => {
  it('conserves the amount: chips + remainder === the bet', () => {
    for (const amount of AMOUNTS) {
      const { runs, remainder } = chipsFor(amount);
      const total = runs.reduce((sum, run) => sum + run.denomination * run.count, 0);
      expect(total + remainder, `$${amount}`).toBeCloseTo(amount, 10);
    }
  });

  it('leaves only what no chip can express', () => {
    for (const amount of AMOUNTS) {
      const { remainder } = chipsFor(amount);
      expect(remainder).toBeGreaterThanOrEqual(0);
      expect(remainder, `$${amount}`).toBeLessThan(SMALLEST);
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
      expect(chipCount(stack), `$${amount}`).toBe(fewestChips(amount));
    }
  });

  it('draws a whole bet with no remainder, at this table minimum', () => {
    // Every legal bet is a multiple of $5 ($5 minimum, $5 increments), so a bet
    // always draws as chips alone. Only payouts and insurance make cents.
    for (let bet = 5; bet <= 500; bet += 5) {
      expect(chipsFor(bet).remainder, `$${bet}`).toBe(0);
    }
  });

  it('expresses an insurance half-bet as its remainder rather than rounding it', () => {
    // $5 insures for $2.50, and there is no $2.50 chip. Rounding it either way
    // would draw a stack worth a different bet than the one placed.
    expect(chipsFor(2.5)).toEqual({ runs: [], remainder: 2.5 });
    expect(chipsFor(12.5)).toEqual({ runs: [{ denomination: 5, count: 2 }], remainder: 2.5 });
  });

  it('has nothing to draw for a seat that is sitting out', () => {
    expect(chipsFor(0)).toEqual({ runs: [], remainder: 0 });
  });

  it('refuses a negative amount rather than drawing a pile', () => {
    expect(() => chipsFor(-5)).toThrow(/cannot be negative/);
  });
});

/** Exhaustive minimum, for the greedy check. Only sound for whole-dollar amounts. */
function fewestChips(amount: number): number {
  const cents = Math.round(amount * 100);
  const best = new Array<number>(cents + 1).fill(Infinity);
  best[0] = 0;
  for (let value = 1; value <= cents; value++) {
    for (const denomination of CHIP_DENOMINATIONS) {
      const step = denomination * 100;
      if (value >= step && best[value - step]! + 1 < best[value]!) {
        best[value] = best[value - step]! + 1;
      }
    }
  }
  return best[cents]!;
}
