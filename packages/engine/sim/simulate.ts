/**
 * The simulation harness (SPEC §8).
 *
 * Plays N hands of perfect basic strategy through the real state machine and
 * reports the resulting house edge. This is the last independent check on M1
 * and M2 taken together: nothing here re-implements the game, so if the edge
 * lands in band then the dealing, the dealer policy, the settlement math and
 * the strategy chart are almost certainly all correct *simultaneously*. Any one
 * of them being wrong moves the number by far more than the sampling error.
 *
 * It lives outside `src/` on purpose. The harness drives the engine; it is not
 * part of the engine's shipped surface, and `tsconfig.json` builds `src` only.
 *
 * Still pure and deterministic: same seed, same result, no clock, no I/O. The
 * caller decides whether to print anything.
 */

import type { Cents } from '../src/money.js';
import {
  advanceUntilDecision,
  applyAction,
  createGame,
  dealerUpcard,
  handAt,
  pendingDecision,
  placeBets,
  recommend,
  recommendInsurance,
  seatAt,
  takeInsurance,
  VEGAS_STRIP,
  type GameEvent,
  type HandOutcome,
  type RoundState,
  type RuleSet,
  type SeatConfig,
} from '../src/index.js';

export type SimOptions = {
  /** Target number of initial hands. Rounds are never cut in half, so the
   *  realised count can overshoot by up to `seats - 1`. */
  readonly hands: number;
  readonly seed: number;
  readonly rules?: RuleSet;
  /** Occupied seats, all playing perfect basic strategy. Default 1. */
  readonly seats?: number;
  /** Flat bet per hand, in cents. Default is the table minimum. */
  readonly bet?: Cents;
  /** Override the auto-sized bankroll, in cents. Must never bind, or play is distorted. */
  readonly bankroll?: Cents;
  readonly onProgress?: (stats: SimStats) => void;
  readonly progressEveryRounds?: number;
};

export type SimStats = {
  readonly rounds: number;
  /** Initial hands dealt — one per seat per round. The unit SPEC §8 counts. */
  readonly hands: number;
  /** Hands settled, so splits count more than once. */
  readonly handsSettled: number;
  /** Base bets only, in cents. This is the house-edge denominator (see below). */
  readonly wagered: Cents;
  /** Every dollar that reached the felt, including doubles, splits, insurance. */
  readonly action: number;
  /** Player-side profit. Negative is a house win, which is the expected sign. */
  readonly net: number;
  /** −net / wagered. The conventional "house edge" quoted for a rule set. */
  readonly houseEdge: number;
  /** −net / action. The "element of risk" figure; always the smaller number. */
  readonly elementOfRisk: number;
  readonly outcomes: Readonly<Record<HandOutcome, number>>;
  /** Player two-card 21s, dealt naturals only — the shuffle's fairness probe. */
  readonly naturals: number;
  readonly doubles: number;
  readonly splits: number;
  readonly insuranceTaken: number;
  /** Rounds in which the dealer actually played the hand out. */
  readonly dealerPlayed: number;
  readonly dealerBusts: number;
  readonly shuffles: number;
};

/**
 * Exact probability that two cards off a fresh 6-deck shoe are a natural:
 * 2 × P(ace) × P(ten | ace). Every dealt pair is an unordered pair drawn
 * without replacement from the full shoe, so this is the expectation for every
 * seat at every position in the shoe, not just the first hand after a shuffle.
 */
export const NATURAL_PROBABILITY = (2 * 24 * 96) / (312 * 311);

type MutableStats = {
  rounds: number;
  hands: number;
  handsSettled: number;
  action: number;
  net: number;
  outcomes: Record<HandOutcome, number>;
  naturals: number;
  doubles: number;
  splits: number;
  insuranceTaken: number;
  dealerPlayed: number;
  dealerBusts: number;
  shuffles: number;
};

export function simulate(options: SimOptions): SimStats {
  const rules = options.rules ?? VEGAS_STRIP;
  const seatCount = options.seats ?? 1;
  const bet = options.bet ?? rules.minBet;

  if (!Number.isInteger(options.hands) || options.hands < 1) {
    throw new Error(`hands must be a positive integer, got ${options.hands}`);
  }
  if (seatCount < 1 || seatCount > rules.seatCount) {
    throw new Error(`seats must be 1..${rules.seatCount}, got ${seatCount}`);
  }
  if (bet < rules.minBet || bet > rules.maxBet) {
    throw new Error(`bet ${bet} is outside the table limits`);
  }

  const bankroll = options.bankroll ?? autoBankroll(options.hands, bet);
  const seatConfigs: SeatConfig[] = [];
  const bets = new Map<number, Cents>();
  for (let i = 0; i < rules.seatCount; i++) {
    const occupied = i < seatCount;
    seatConfigs.push({
      occupant: occupied ? { kind: 'player' } : { kind: 'empty' },
      bankroll: occupied ? bankroll : 0,
    });
    if (occupied) bets.set(i, bet);
  }

  const stats: MutableStats = {
    rounds: 0,
    hands: 0,
    handsSettled: 0,
    action: 0,
    net: 0,
    outcomes: { blackjack: 0, win: 0, push: 0, lose: 0, bust: 0, surrender: 0 },
    naturals: 0,
    doubles: 0,
    splits: 0,
    insuranceTaken: 0,
    dealerPlayed: 0,
    dealerBusts: 0,
    shuffles: 0,
  };

  const progressEvery = options.progressEveryRounds ?? 0;
  let state = createGame({ rules, seed: options.seed, seats: seatConfigs });

  for (;;) {
    const decision = pendingDecision(state);

    if (decision === null) {
      const step = advanceUntilDecision(state);
      state = step.state;
      tally(stats, step.events);
      continue;
    }

    switch (decision.kind) {
      // The only place the loop is allowed to stop. Bets for the next round are
      // not yet placed, so every bankroll is whole and the money check below is
      // meaningful.
      case 'bets': {
        if (stats.hands >= options.hands) {
          checkMoneyConservation(state, stats, bankroll, seatCount);
          return finalise(stats, bet);
        }
        const step = placeBets(state, bets);
        state = step.state;
        tally(stats, step.events);
        stats.rounds++;
        stats.hands += seatCount;
        if (progressEvery > 0 && options.onProgress && stats.rounds % progressEvery === 0) {
          options.onProgress(finalise(stats, bet));
        }
        break;
      }

      // Basic strategy declines insurance unconditionally (SPEC §5.4). Asking
      // through `recommendInsurance()` rather than hardcoding `false` means the
      // harness measures the shipped advice, not a copy of it.
      case 'insurance': {
        const take = recommendInsurance().take;
        for (const seatIndex of decision.seats) {
          const step = takeInsurance(state, seatIndex, take);
          state = step.state;
          tally(stats, step.events);
        }
        break;
      }

      case 'action': {
        const seat = seatAt(state, decision.seat);
        const upcard = dealerUpcard(state);
        if (upcard === undefined) throw new Error('Player to act with no dealer upcard');
        const { action } = recommend(handAt(seat, decision.handIndex), upcard, {
          rules,
          handCount: seat.hands.length,
          availableFunds: seat.bankroll,
        });
        const step = applyAction(state, decision.seat, action);
        state = step.state;
        tally(stats, step.events);
        break;
      }
    }
  }
}

function tally(stats: MutableStats, events: readonly GameEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case 'CardDealt':
        // Only the second card of the initial deal can reach 21, and only with
        // an ace alongside a ten. No other event exposes a dealt natural.
        if (event.initialDeal && event.seat !== 'dealer' && event.total === 21) stats.naturals++;
        break;
      case 'HandDoubled':
        stats.doubles++;
        break;
      case 'HandSplit':
        stats.splits++;
        break;
      case 'InsuranceTaken':
        stats.insuranceTaken++;
        break;
      case 'DealerStood':
        stats.dealerPlayed++;
        break;
      case 'DealerBusted':
        stats.dealerPlayed++;
        stats.dealerBusts++;
        break;
      case 'HandSettled':
        stats.handsSettled++;
        stats.action += event.bet;
        stats.net += event.net;
        stats.outcomes[event.outcome]++;
        break;
      case 'InsuranceSettled':
        stats.action += event.bet;
        stats.net += event.net;
        break;
      case 'ShuffleStarted':
        stats.shuffles++;
        break;
      default:
        break;
    }
  }
}

/**
 * The money has to add up exactly.
 *
 * Every settlement is a multiple of half the bet, so with a sane bet size the
 * running total is exactly representable and this is a true equality rather
 * than a tolerance — but the tolerance is there because `bet` is a caller
 * parameter and nothing stops it being 5.01.
 *
 * This catches a whole class of bug the edge alone would hide: a payout that
 * credits the wrong seat, or a stake that is deducted twice, can leave the
 * aggregate edge plausible while the bankrolls are wrong.
 */
function checkMoneyConservation(
  state: RoundState,
  stats: MutableStats,
  startingBankroll: number,
  seatCount: number,
): void {
  let bankrollDelta = 0;
  for (let i = 0; i < seatCount; i++) bankrollDelta += seatAt(state, i).bankroll - startingBankroll;
  const drift = Math.abs(bankrollDelta - stats.net);
  if (drift > 1e-6 * Math.max(1, Math.abs(stats.net))) {
    throw new Error(
      `Money is not conserved: settlements sum to ${stats.net} but bankrolls moved ` +
        `${bankrollDelta} (drift ${drift})`,
    );
  }
}

function finalise(stats: MutableStats, bet: number): SimStats {
  const wagered = stats.hands * bet;
  return {
    rounds: stats.rounds,
    hands: stats.hands,
    handsSettled: stats.handsSettled,
    wagered,
    action: stats.action,
    net: stats.net,
    houseEdge: -stats.net / wagered,
    elementOfRisk: -stats.net / stats.action,
    outcomes: { ...stats.outcomes },
    naturals: stats.naturals,
    doubles: stats.doubles,
    splits: stats.splits,
    insuranceTaken: stats.insuranceTaken,
    dealerPlayed: stats.dealerPlayed,
    dealerBusts: stats.dealerBusts,
    shuffles: stats.shuffles,
  };
}

/**
 * Big enough that the bankroll never binds. It must not: `legalActions` gates
 * doubling and splitting on available funds, so a seat that runs short stops
 * playing basic strategy and quietly biases the edge upwards. Five percent of
 * total turnover is roughly a twelve-sigma cushion on the expected loss.
 */
/**
 * A bankroll large enough never to bind, in whole cents.
 *
 * `Math.ceil` is not defensive tidying. The `× 0.05` is the one multiplication
 * left in the money path that can land off a cent boundary — for most stakes it
 * happens to divide evenly, which is exactly why it would have gone unnoticed —
 * and a fractional bankroll puts float noise straight back into
 * `checkMoneyConservation`, which compares settlements against bankroll movement
 * for exact equality. Rounding *up* because the number's only job is to be large
 * enough not to matter (decision 11).
 */
function autoBankroll(hands: number, bet: Cents): Cents {
  return Math.ceil(Math.max(1000 * bet, hands * bet * 0.05));
}

// --- Reporting -------------------------------------------------------------

const pct = (value: number): string => `${(value * 100).toFixed(4)}%`;
const rate = (count: number, total: number): string =>
  total === 0 ? 'n/a' : `${((100 * count) / total).toFixed(3)}%`;

/** Thousands separators without reaching for `Intl`, which `lib: ES2022` on its
 *  own does not guarantee is typed here. */
export function group(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const [whole = '', fraction] = Math.abs(rounded).toString().split('.');
  const sign = rounded < 0 ? '-' : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`;
}

/** Human-readable summary. Diagnostics included, so a failure says *where* to look. */
export function formatSimReport(stats: SimStats): string {
  const lines = [
    `hands        ${group(stats.hands)} over ${group(stats.rounds)} rounds, ${stats.shuffles} shuffles`,
    `settled      ${group(stats.handsSettled)} (splits add hands)`,
    `wagered      ${group(stats.wagered)} base / ${group(stats.action)} total action`,
    `net          ${group(stats.net)}`,
    `house edge   ${pct(stats.houseEdge)}  (element of risk ${pct(stats.elementOfRisk)})`,
    '',
    `naturals     ${rate(stats.naturals, stats.hands)} of hands (expect ${pct(NATURAL_PROBABILITY)})`,
    `doubles      ${rate(stats.doubles, stats.hands)} of hands`,
    `splits       ${rate(stats.splits, stats.hands)} of hands`,
    `insurance    ${stats.insuranceTaken} taken`,
    `dealer bust  ${rate(stats.dealerBusts, stats.dealerPlayed)} of hands played out`,
    '',
    'outcomes     ' +
      (Object.keys(stats.outcomes) as HandOutcome[])
        .map((outcome) => `${outcome} ${rate(stats.outcomes[outcome], stats.handsSettled)}`)
        .join('  '),
  ];
  return lines.join('\n');
}
