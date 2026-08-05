/**
 * The 10-million-hand simulation (SPEC §8).
 *
 * Excluded from `npm test` by `vitest.config.ts`; run with `npm run sim`.
 *
 * What makes this test worth its runtime is that it shares no code with the
 * things it is checking. It places real bets, takes real decisions from
 * `recommend()`, and reads the resulting bankrolls. There is no arrangement of
 * a broken dealer policy, a mis-signed payout or a wrong chart cell that leaves
 * the house edge inside a 0.20-point band by accident.
 *
 * Overridable so a shorter run can be taken by hand:
 *   SIM_HANDS=250000 SIM_SEED=7 SIM_SEATS=3 npm run sim --workspace @bj/engine
 */

import { describe, expect, it } from 'vitest';
import { EXPECTED_HOUSE_EDGE } from '../src/index.js';
import { formatSimReport, group, NATURAL_PROBABILITY, simulate } from '../sim/simulate.js';

// `@types/node` is deliberately not a dependency of this package. The harness
// itself is pure and needs nothing from Node; this file wants exactly two
// globals for configuration and output, so it declares the slice it uses rather
// than pulling a types package in for them.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
declare const console: { log(...args: readonly unknown[]): void };

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name}=${raw} is not a number`);
  return value;
}

const HANDS = envNumber('SIM_HANDS', 10_000_000);
const SEED = envNumber('SIM_SEED', 20260805);
const SEATS = envNumber('SIM_SEATS', 1);

describe('simulation harness', () => {
  it(`plays ${group(HANDS)} hands of perfect basic strategy at the expected house edge`, () => {
    const started = Date.now();
    const stats = simulate({
      hands: HANDS,
      seed: SEED,
      seats: SEATS,
      // A 10M-hand run is minutes, not seconds; a heartbeat says it is alive
      // and lets the edge be watched converging.
      progressEveryRounds: 250_000,
      onProgress: (partial) => {
        console.log(
          `  ${group(partial.hands)} hands — edge so far ${(partial.houseEdge * 100).toFixed(4)}%`,
        );
      },
    });
    const elapsed = (Date.now() - started) / 1000;

    console.log(`\n${formatSimReport(stats)}\nelapsed      ${elapsed.toFixed(1)}s\n`);

    expect(stats.hands).toBeGreaterThanOrEqual(HANDS);

    // The headline assertion (SPEC §8). Sampling error over 10M hands is about
    // 0.036 points against a 0.20-point band, so a failure here is a defect and
    // not bad luck.
    expect(stats.houseEdge).toBeGreaterThan(EXPECTED_HOUSE_EDGE.min);
    expect(stats.houseEdge).toBeLessThan(EXPECTED_HOUSE_EDGE.max);

    // The edge is a single number, and a compensating pair of bugs could in
    // principle land it in band. These pin down its inputs separately.

    // Shuffle fairness and the deal order: the natural rate has an exact closed
    // form and no dependence on strategy, settlement or dealer policy. The
    // tolerance is five standard errors of the sample rather than a constant,
    // so a shortened run via SIM_HANDS stays honest instead of flaky.
    const naturalError = Math.sqrt(
      (NATURAL_PROBABILITY * (1 - NATURAL_PROBABILITY)) / stats.hands,
    );
    expect(stats.naturals / stats.hands).toBeGreaterThan(NATURAL_PROBABILITY - 5 * naturalError);
    expect(stats.naturals / stats.hands).toBeLessThan(NATURAL_PROBABILITY + 5 * naturalError);

    // Basic strategy doubles roughly 9% of hands and splits roughly 2.5%. A
    // chart that stopped recommending either would still produce a plausible
    // edge; a zero here would not show up in the headline number.
    expect(stats.doubles / stats.hands).toBeGreaterThan(0.05);
    expect(stats.doubles / stats.hands).toBeLessThan(0.15);
    expect(stats.splits / stats.hands).toBeGreaterThan(0.01);
    expect(stats.splits / stats.hands).toBeLessThan(0.06);

    // Basic strategy never insures (SPEC §5.4).
    expect(stats.insuranceTaken).toBe(0);

    // The shoe reshuffled regularly rather than once at the start.
    expect(stats.shuffles).toBeGreaterThan(stats.rounds / 100);
  });
});
