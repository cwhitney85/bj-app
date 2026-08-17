/**
 * The full-size versions of the two statistical claims M3 makes (SPEC §6, §7).
 *
 * Excluded from `npm test` by `vitest.config.ts`; run with `npm run sim`,
 * alongside the 10-million-hand simulation.
 *
 * `bots.test.ts` and `replay.test.ts` each carry a smaller version of what is
 * here, sized so the fast suite stays a fast suite. Those smaller runs clear
 * three standard errors, which is enough to fail on a defect and not enough to
 * quote. These are the runs whose numbers are worth writing down:
 *
 *   1. Every bad habit costs its own seat money, measured against the book on
 *      the same shoe (SPEC §6). Six standard errors, not three, and the figure
 *      is printed as a percentage of a base bet.
 *   2. A bad player at third base helps you as often as they hurt you
 *      (SPEC §7) — the claim the whole counterfactual feature exists to make.
 *
 * Overridable so a shorter run can be taken by hand:
 *   JERK_SCALE=0.1 JERK_SEED=7 npm run sim --workspace @bj/engine
 */

import { describe, expect, it } from 'vitest';

import type { GameEvent } from '../src/events.js';
import {
  addToTally,
  advanceUntilDecision,
  counterfactual,
  createGame,
  EMPTY_JERK_TALLY,
  flatBettor,
  JERK_POLICIES,
  PERFECT_POLICY,
  playRound,
  policyById,
  recordRound,
  VEGAS_STRIP,
  type BotPolicy,
  type Deciders,
  type RoundState,
  type SeatConfig,
} from '../src/index.js';

// `@types/node` is deliberately not a dependency of this package; this file
// wants exactly two globals for configuration and output, so it declares the
// slice it uses rather than pulling a types package in for them. Same shim as
// `sim.slow.test.ts`.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
declare const console: { log(...args: readonly unknown[]): void };

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name}=${raw} is not a number`);
  return value;
}

/** Scales every sample below, so a shortened run stays proportioned. */
const SCALE = envNumber('JERK_SCALE', 1);
const SEED = envNumber('JERK_SEED', 20260807);
const BET = 500;

const scaled = (rounds: number): number => Math.max(1000, Math.round(rounds * SCALE));

function game(seed: number, specs: readonly (BotPolicy | 'player' | 'empty')[]): RoundState {
  const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => {
    const spec = specs[i] ?? 'empty';
    if (spec === 'empty') return { occupant: { kind: 'empty' } as const, bankroll: 0 };
    if (spec === 'player') return { occupant: { kind: 'player' } as const, bankroll: 1_000_000_000 };
    return {
      occupant: { kind: 'bot', policyId: spec.id, characterId: `c${i}` } as const,
      bankroll: 1_000_000_000,
    };
  });
  return createGame({ rules: VEGAS_STRIP, seed, seats });
}

function netOf(events: readonly GameEvent[]): number {
  let net = 0;
  for (const event of events) {
    if (event.type === 'HandSettled' || event.type === 'InsuranceSettled') net += event.net;
  }
  return net;
}

// --- 1. Every bad habit is bad ---------------------------------------------

/**
 * The cost of one habit to its own seat, per round, in cents.
 *
 * Every round is played twice from the identical starting state: once as the
 * habit plays it, once with that seat playing the book. The difference is
 * exactly zero on every round where the habit made no different decision, so the
 * variance that would otherwise swamp a quarter-of-a-percent effect is never
 * sampled at all. Two independent sessions compared by bankroll would need
 * millions of rounds to separate the weakest of these from noise.
 */
function costOfHabit(
  policy: BotPolicy,
  rounds: number,
  seed: number,
): { mean: number; standardError: number; changed: number } {
  const jerk: Deciders = new Map([[0, flatBettor(policy, BET)]]);
  const book: Deciders = new Map([[0, flatBettor(PERFECT_POLICY, BET)]]);
  let state = game(seed, [policy]);
  let total = 0;
  let sumSquares = 0;
  let changed = 0;

  for (let i = 0; i < rounds; i++) {
    const betting = advanceUntilDecision(state).state;
    const played = playRound(betting, jerk);
    const corrected = playRound(betting, book);
    const delta = netOf(corrected.events) - netOf(played.events);
    total += delta;
    sumSquares += delta * delta;
    if (Math.abs(delta) > 1e-9) changed++;
    state = played.state;
  }

  const mean = total / rounds;
  const variance = (sumSquares - rounds * mean * mean) / (rounds - 1);
  return { mean, standardError: Math.sqrt(variance / rounds), changed };
}

describe('every bad habit costs real money (SPEC §6)', () => {
  it.each([
    { id: 'always-insures', rounds: 600_000 },
    { id: 'hits-every-16', rounds: 100_000 },
    { id: 'never-splits', rounds: 150_000 },
    { id: 'stands-on-soft-17', rounds: 200_000 },
    { id: 'doubles-twelve', rounds: 50_000 },
    { id: 'mimics-dealer', rounds: 30_000 },
  ])('$id', ({ id, rounds }) => {
    const sample = scaled(rounds);
    const policy = policyById(id);
    const cost = costOfHabit(policy, sample, SEED);
    const perBet = cost.mean / BET;

    console.log(
      `  ${id.padEnd(18)} ${(100 * perBet).toFixed(3)}% of a base bet per round ` +
        `(${(cost.mean / cost.standardError).toFixed(1)}σ, changed ` +
        `${((100 * cost.changed) / sample).toFixed(2)}% of rounds)`,
    );

    // Positive = the book would have earned more = the habit costs money.
    // Six standard errors, so this is a statement about the game rather than
    // about the seed. The samples are sized per habit because the habits differ
    // in cost by more than an order of magnitude — 0.26% of a bet per round for
    // always insuring against 6.3% for mimicking the dealer — and a single
    // sample size would be either flaky at one end or wasteful at the other.
    // As sized, every habit lands between 6σ and 14σ.
    expect(cost.mean, id).toBeGreaterThan(6 * cost.standardError);
    // Nothing here should cost a whole bet per round; a number that large means
    // the measurement is wrong, not that the habit is.
    expect(perBet, id).toBeLessThan(1);
  });

  it('covers all six habits SPEC §6 names', () => {
    expect(JERK_POLICIES).toHaveLength(6);
  });
});

// --- 2. The third-base myth -------------------------------------------------

describe('a bad player at third base helps you as often as they hurt you (SPEC §7)', () => {
  type Tallied = {
    readonly helped: number;
    readonly hurt: number;
    readonly unchanged: number;
    readonly netDelta: number;
    readonly sumSquares: number;
    readonly rounds: number;
  };

  /**
   * Sit the player at first base with one jerk behind them and tally, round by
   * round, what that jerk's play was worth. That seating is the arrangement the
   * myth is about: the jerk's extra cards cannot reach the player's hand, only
   * the dealer's, so whatever effect exists has to run through the dealer.
   */
  function tallyAgainst(jerk: BotPolicy, rounds: number): Tallied {
    const deciders: Deciders = new Map([
      [0, flatBettor(PERFECT_POLICY, BET)],
      [1, flatBettor(jerk, BET)],
    ]);
    let state = game(SEED, ['player', jerk]);
    let tally = EMPTY_JERK_TALLY;
    let sumSquares = 0;

    for (let i = 0; i < rounds; i++) {
      const betting = advanceUntilDecision(state).state;
      const played = playRound(betting, deciders);
      const result = counterfactual(recordRound(betting, played.events), played.events, {
        correctedSeat: 1,
        observedSeat: 0,
      });
      tally = addToTally(tally, result);
      sumSquares += result.delta * result.delta;
      state = played.state;
    }

    return { ...tally, sumSquares, rounds };
  }

  /**
   * Insurance is a side bet: it costs the jerk money and consumes no cards, so
   * it cannot move a single card to any other seat. This habit is therefore not
   * merely even for the rest of the table, it is *exactly* inert — which makes
   * it the one case where the myth can be refuted without any statistics at all.
   */
  it('an always-insures jerk cannot change another seat’s result at all', () => {
    const tally = tallyAgainst(policyById('always-insures'), scaled(50_000));
    expect(tally.helped).toBe(0);
    expect(tally.hurt).toBe(0);
    expect(tally.netDelta).toBe(0);
    expect(tally.unchanged).toBe(tally.rounds);
  });

  it.each(
    JERK_POLICIES.filter((policy) => policy.id !== 'always-insures').map((policy) => ({
      id: policy.id,
    })),
  )('the tally converges on even with a $id at the table', ({ id }) => {
    const rounds = scaled(100_000);
    const tally = tallyAgainst(policyById(id), rounds);
    const changed = tally.helped + tally.hurt;
    const wagered = rounds * BET;

    console.log(
      `  ${id.padEnd(18)} helped ${tally.helped} / hurt ${tally.hurt} ` +
        `(${((100 * changed) / rounds).toFixed(1)}% of rounds changed), ` +
        `net ${tally.netDelta.toFixed(2)} on ${wagered} wagered ` +
        `(${((100 * tally.netDelta) / wagered).toFixed(3)}%)`,
    );

    expect(changed).toBeGreaterThan(rounds / 500);

    // The gap between helped and hurt under the myth's own claim — that a bad
    // play is a coin flip for you — is a binomial with standard error √changed.
    // Expressed in standard errors rather than a constant so a shortened run via
    // JERK_SCALE stays honest instead of flaky.
    expect(Math.abs(tally.helped - tally.hurt)).toBeLessThan(4 * Math.sqrt(changed));

    // And the money agrees. √(Σδ²) is the standard error of the summed delta
    // once the mean is negligible, which is exactly the hypothesis under test.
    // This is also the "small relative to the money wagered" claim in its only
    // scale-free form: the bound shrinks as √rounds while the action grows as
    // rounds, so at 100,000 rounds it is a few tenths of one percent of the
    // action and it keeps tightening.
    expect(Math.abs(tally.netDelta)).toBeLessThan(4 * Math.sqrt(tally.sumSquares));
  });
});
