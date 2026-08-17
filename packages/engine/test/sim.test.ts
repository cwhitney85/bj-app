/**
 * Tests for the simulation harness itself.
 *
 * The harness carries the highest-value assertion in the project (SPEC §8) but
 * runs nightly, which means a bug in the *harness* could sit undetected for a
 * day and then present as a false alarm about the engine. These run on every
 * push over a few tens of thousands of hands: enough to exercise every path the
 * 10M-hand run takes — shuffles, splits, doubles, insurance offers, naturals —
 * without the runtime.
 *
 * Nothing here asserts a tight house edge. That is the slow test's job; at this
 * sample size the standard error is larger than the quantity being measured.
 */

import { describe, expect, it } from 'vitest';
import { VEGAS_STRIP, type HandOutcome } from '../src/index.js';
import { formatSimReport, group, NATURAL_PROBABILITY, simulate } from '../sim/simulate.js';

const HANDS = 20_000;
const SEED = 4242;

describe('simulate', () => {
  it('is deterministic: the same seed replays to the same statistics', () => {
    const first = simulate({ hands: HANDS, seed: SEED });
    const second = simulate({ hands: HANDS, seed: SEED });
    expect(second).toEqual(first);
  });

  it('is seeded, not fixed: a different seed produces a different session', () => {
    const first = simulate({ hands: HANDS, seed: SEED });
    const second = simulate({ hands: HANDS, seed: SEED + 1 });
    expect(second.net).not.toBe(first.net);
  });

  it('keeps its bookkeeping consistent', () => {
    const stats = simulate({ hands: HANDS, seed: SEED, bet: 2500 });

    expect(stats.hands).toBe(HANDS);
    expect(stats.rounds).toBe(HANDS);
    expect(stats.wagered).toBe(HANDS * 2500);

    // Splitting creates hands and adds stake; doubling adds stake only. Both
    // happen often enough at this sample size that these are strict.
    expect(stats.handsSettled).toBe(HANDS + stats.splits);
    expect(stats.action).toBeGreaterThan(stats.wagered);

    const settled = (Object.keys(stats.outcomes) as HandOutcome[]).reduce(
      (sum, outcome) => sum + stats.outcomes[outcome],
      0,
    );
    expect(settled).toBe(stats.handsSettled);
  });

  it('deals every seat in, and every seat plays the book', () => {
    const stats = simulate({ hands: HANDS, seed: SEED, seats: 5 });

    expect(stats.hands).toBe(stats.rounds * 5);
    expect(stats.hands).toBeGreaterThanOrEqual(HANDS);
    // Stopping is only allowed between rounds, so the overshoot is bounded by
    // one round's worth of hands.
    expect(stats.hands - HANDS).toBeLessThan(5);
    // Per *round* five seats burn far more of the shoe, but per *hand* they
    // burn less: the dealer's two-to-five cards are shared across five hands
    // instead of paying for one. Same hand count, so the cut card fires less
    // often here than in the single-seat run.
    expect(stats.shuffles).toBeGreaterThan(0);
    expect(stats.shuffles).toBeLessThan(simulate({ hands: HANDS, seed: SEED }).shuffles);
  });

  it('reaches every part of the round it is meant to exercise', () => {
    const stats = simulate({ hands: HANDS, seed: SEED, seats: 3 });

    expect(stats.shuffles).toBeGreaterThan(0);
    expect(stats.doubles).toBeGreaterThan(0);
    expect(stats.splits).toBeGreaterThan(0);
    expect(stats.dealerBusts).toBeGreaterThan(0);
    expect(stats.outcomes.blackjack).toBeGreaterThan(0);
    expect(stats.outcomes.push).toBeGreaterThan(0);
    expect(stats.outcomes.bust).toBeGreaterThan(0);
    // No surrender under VEGAS_STRIP (SPEC §2), and basic strategy never
    // insures (SPEC §5.4) — so these two must be flat zero, not merely small.
    expect(stats.outcomes.surrender).toBe(0);
    expect(stats.insuranceTaken).toBe(0);
  });

  it('produces a result in the right ballpark', () => {
    const stats = simulate({ hands: 40_000, seed: SEED });

    // Deliberately loose: one standard error at 40k hands is about 0.6 points,
    // so anything tighter would be flaky. This catches a sign error or a
    // wholesale breakage, and leaves the real measurement to the slow test.
    expect(stats.houseEdge).toBeGreaterThan(-0.02);
    expect(stats.houseEdge).toBeLessThan(0.03);
    // Same numerator over a larger denominator, so the element of risk is
    // always the smaller *magnitude*. Comparing the signed values instead would
    // invert on any sample where the player finished ahead.
    expect(Math.abs(stats.elementOfRisk)).toBeLessThan(Math.abs(stats.houseEdge));

    // Four sigma on the natural rate — independent of strategy and settlement,
    // so it stays meaningful even at this sample size.
    const error = Math.sqrt((NATURAL_PROBABILITY * (1 - NATURAL_PROBABILITY)) / stats.hands);
    expect(stats.naturals / stats.hands).toBeGreaterThan(NATURAL_PROBABILITY - 4 * error);
    expect(stats.naturals / stats.hands).toBeLessThan(NATURAL_PROBABILITY + 4 * error);
  });

  it('rejects options that would silently distort the result', () => {
    expect(() => simulate({ hands: 0, seed: SEED })).toThrow(/positive integer/);
    expect(() => simulate({ hands: 1.5, seed: SEED })).toThrow(/positive integer/);
    expect(() => simulate({ hands: HANDS, seed: SEED, seats: 0 })).toThrow(/seats must be/);
    expect(() => simulate({ hands: HANDS, seed: SEED, seats: 8 })).toThrow(/seats must be/);
    expect(() => simulate({ hands: HANDS, seed: SEED, bet: VEGAS_STRIP.minBet - 1 })).toThrow(
      /table limits/,
    );
    expect(() => simulate({ hands: HANDS, seed: SEED, bet: VEGAS_STRIP.maxBet + 1 })).toThrow(
      /table limits/,
    );
  });

  it('reports progress on the requested cadence', () => {
    const seen: number[] = [];
    simulate({
      hands: 1000,
      seed: SEED,
      progressEveryRounds: 250,
      onProgress: (partial) => seen.push(partial.hands),
    });
    expect(seen).toEqual([250, 500, 750, 1000]);
  });
});

describe('formatSimReport', () => {
  it('reports the headline numbers', () => {
    const report = formatSimReport(simulate({ hands: 2000, seed: SEED }));
    expect(report).toContain('house edge');
    expect(report).toContain('naturals');
    expect(report).toContain('dealer bust');
  });
});

describe('group', () => {
  it('inserts thousands separators without Intl', () => {
    expect(group(0)).toBe('0');
    expect(group(999)).toBe('999');
    expect(group(1000)).toBe('1,000');
    expect(group(10_000_000)).toBe('10,000,000');
    expect(group(-2147.5)).toBe('-2,147.5');
  });
});
