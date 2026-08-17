/**
 * The session report card (SPEC §9) — what a session cost, and how much of that
 * the player chose.
 *
 * Every number here is a sum over things that were already computed and already
 * priced: `assess` (coach.ts) scored each decision when it was made, `seatResult`
 * (replay.ts) totalled each round out of its own event stream, and
 * `addToTally` (replay.ts) counted the §7 verdicts. This module adds no
 * arithmetic about the game — it does not know what a hand is worth, what the
 * dealer was showing, or what the chart says. It groups and it sums.
 *
 * It lives in the engine rather than in the report screen for the same reason
 * `session.ts` and `coach.ts` do: the alternative is a React component
 * computing "estimated EV lost to deviations, in dollars", which is the single
 * number SPEC §9 says makes the lesson concrete and the single number nobody
 * would ever assert if it lived in a view. Its sign is trivially easy to invert
 * and the resulting bug is invisible — the report would still read plausibly,
 * with the player's worst sessions shown as their best. That is the failure mode
 * `coach.ts` decision 42 and `replay.ts` decision 29 both exist to pin, and this
 * module inherits it, so it is pinned here too.
 *
 * What is *not* here: the log itself. Keeping a `Decision[]` and a `SeatResult[]`
 * across app launches is persistence (MMKV, SPEC §9), and persistence is not the
 * engine's business. This module is the pure function that log is kept *for*.
 */

import type { Cents } from './money.js';
import type { Decision } from './coach.js';
import type { GameEvent } from './events.js';
import { seatResult, type JerkTally, type SeatResult } from './replay.js';
import type { ReasonCode } from './strategy.js';

/**
 * One session's raw log — the three things the app accumulates as it plays.
 *
 * Precondition: `decisions` and `rounds` describe the same seat over the same
 * session. Nothing here can check that, because a `Decision` deliberately does
 * not carry a seat or a round number: it is scored from the `Coaching` the
 * player was shown (coach.ts decision 45), and that object is about one hand at
 * one instant. Mixing two seats' logs would produce a report that is
 * arithmetically correct and about nobody.
 */
export type SessionLog = {
  /** Every decision the player was coached on, in the order they were made. */
  readonly decisions: readonly Decision[];
  /** One entry per completed round, from that round's own event stream. */
  readonly rounds: readonly SeatResult[];
  /** SPEC §7's tally. `EMPTY_JERK_TALLY` when Jerk Mode was off. */
  readonly jerk: JerkTally;
};

/**
 * One kind of mistake, aggregated. `reasonCode` is the code behind the *book*
 * answer the player declined, not a description of what they did instead —
 * "you were being told to stand because the dealer is weak" is the lesson, and
 * it is the same lesson whether they hit or doubled.
 */
export type Mistake = {
  readonly reasonCode: ReasonCode;
  /** How many times the player deviated from a recommendation with this code. */
  readonly count: number;
  /** Money given up across those deviations. Positive means lost. */
  readonly evLost: Cents;
};

/**
 * The report card. Money fields are in **cents** at the stakes actually played;
 * `accuracy` is a fraction in [0, 1], not a percentage.
 *
 * `net`, `biggestWin` and `biggestLoss` are integer cents — money that moved.
 * `evLost` is real cents, because it is a sum of expectations rather than of
 * payments (money.ts). Both are the same unit, which is what stops the one line
 * where they meet from being a place a missing `× 100` looks plausible.
 */
export type SessionReport = {
  /** Rounds the player was dealt into. Sitting out is not a round. */
  readonly roundsPlayed: number;
  /** Hands settled. Larger than `roundsPlayed` exactly as often as splits happen. */
  readonly handsPlayed: number;
  /** Profit across the session, insurance included. Negative is a loss. */
  readonly net: Cents;
  /** Best round, signed. 0 when no round was ever won. */
  readonly biggestWin: Cents;
  /** Worst round, signed — so this number is negative or 0, never a magnitude. */
  readonly biggestLoss: Cents;

  /** Decisions the player was coached on: actions plus insurance offers. */
  readonly decisionsMade: number;
  /** Of those, how many departed from the book. */
  readonly deviations: number;
  /**
   * Fraction of decisions that followed the book, or `null` when there were no
   * decisions to follow. Deliberately not 1: a player who has not yet acted has
   * not been perfect, and every sentence this app renders has to be defensible
   * (explain.ts decision 15).
   */
  readonly accuracy: number | null;
  /**
   * SPEC §9's headline: estimated EV lost to deviations, in dollars. Positive
   * means the deviations cost money.
   *
   * Not clamped at zero. In the composition-dependent cells where the EV
   * calculator disagrees with the chart, a deviation is genuinely worth
   * marginally more, and those gains offset here. Clamping would report a larger
   * loss than the player actually took, which is the same lie as reporting a
   * smaller one.
   */
  readonly evLost: Cents;
  /** Deviations grouped by the lesson they missed, most expensive first. */
  readonly mistakes: readonly Mistake[];

  /** Carried through untouched, so the report is one object the screen reads. */
  readonly jerk: JerkTally;
};

/**
 * Build the report card from a session's log.
 *
 * Postconditions, all asserted in `test/report.test.ts`:
 * - `evLost === -Σ decisions.moneyDelta`, and a followed recommendation
 *   contributes exactly 0 to it.
 * - `mistakes` partitions the deviations: the counts sum to `deviations` and the
 *   costs sum to `evLost`.
 * - `net === Σ rounds.net`, and `biggestWin`/`biggestLoss` are members of that
 *   set or 0.
 */
export function sessionReport(log: SessionLog): SessionReport {
  const { decisions, rounds, jerk } = log;

  let net = 0;
  let handsPlayed = 0;
  let biggestWin = 0;
  let biggestLoss = 0;
  for (const round of rounds) {
    net += round.net;
    handsPlayed += round.hands.length;
    if (round.net > biggestWin) biggestWin = round.net;
    if (round.net < biggestLoss) biggestLoss = round.net;
  }

  // One pass, and `evLost` sums over *every* decision rather than only the
  // deviations. Those are the same number — a followed recommendation is scored
  // against itself and its `moneyDelta` is exactly 0 — and summing the whole log
  // is the form that makes that equivalence testable rather than assumed.
  let followed = 0;
  let moneyDelta = 0;
  for (const decision of decisions) {
    if (decision.wasRecommended) followed += 1;
    moneyDelta += decision.moneyDelta;
  }

  return {
    roundsPlayed: rounds.length,
    handsPlayed,
    net,
    biggestWin,
    biggestLoss,
    decisionsMade: decisions.length,
    deviations: decisions.length - followed,
    accuracy: decisions.length === 0 ? null : followed / decisions.length,
    // `0 - x`, not `-x`. They differ at exactly one input: negating a zero sum
    // yields `-0`, so a session played perfectly would report its cost as
    // "-$0.00". The two are otherwise identical, and this one is also `+0` for a
    // `-0` input, which `Object.is` and every equality check downstream can see.
    evLost: 0 - moneyDelta,
    mistakes: rankMistakes(decisions),
    jerk,
  };
}

/**
 * Split a session's event stream into one `SeatResult` per round the seat was
 * dealt into.
 *
 * The app holds every event already — it drains them into the animation queue
 * (SPEC §3) — but it holds them as one flat list, and `seatResult` totals a
 * stream without regard to where rounds begin. Totalling the whole session with
 * it gives the right `net` and no `biggestWin`, because the round boundaries are
 * gone. This restores them.
 *
 * The boundary is `RoundStarted`, which is emitted in exactly one place
 * (`startRound`, PLAN decision 21) and lands before any of its round's cards and
 * after all of the previous round's settlements — the dealer settles in
 * `settlement`, two phases before the `idle -> betting` step that opens the next
 * round. So a split on `RoundStarted` cannot cut a round's money in half.
 *
 * Events preceding the first `RoundStarted` form their own segment rather than
 * being discarded, so passing a stream that begins mid-round loses nothing.
 *
 * **Rounds the seat sat out are dropped**, because "rounds played" means rounds
 * the player was dealt into. A seat with no settlement and no insurance did not
 * play; counting it would dilute every per-round figure on the report card.
 */
export function roundResults(
  events: readonly GameEvent[],
  seatIndex: number,
): readonly SeatResult[] {
  const segments: GameEvent[][] = [[]];
  for (const event of events) {
    if (event.type === 'RoundStarted') segments.push([]);
    const current = segments[segments.length - 1];
    if (current !== undefined) current.push(event);
  }

  return segments
    .map((segment) => seatResult(segment, seatIndex))
    .filter((result) => result.hands.length > 0 || result.insuranceNet !== 0);
}

/**
 * Group the deviations by the book answer they declined, and rank them.
 *
 * **Ranked by money, not by frequency.** SPEC §9 asks for "your most frequent
 * mistakes, ranked" and does not say ranked by what. Frequency is the reading
 * that loses: the narrowest cells on the chart are also the ones a learner gets
 * wrong most often, so a frequency ranking reliably puts a 1¢ stand-versus-hit
 * at the top and buries the 30¢ double-on-twelve underneath it. The list sits
 * directly beside `evLost`, whose entire purpose is to make the cost concrete,
 * and a list ordered against that number would argue with it. `count` ships on
 * every entry so a screen that wants the other ordering has it without
 * recomputing anything.
 *
 * Ties break on count, then on the code itself, so the ranking is total and the
 * report is a pure function of its input rather than of insertion order.
 */
function rankMistakes(decisions: readonly Decision[]): readonly Mistake[] {
  const byCode = new Map<ReasonCode, { count: number; evLost: number }>();

  for (const decision of decisions) {
    if (decision.wasRecommended) continue;
    const entry = byCode.get(decision.reasonCode) ?? { count: 0, evLost: 0 };
    entry.count += 1;
    entry.evLost -= decision.moneyDelta;
    byCode.set(decision.reasonCode, entry);
  }

  return [...byCode]
    .map(([reasonCode, entry]) => ({ reasonCode, count: entry.count, evLost: entry.evLost }))
    .sort(
      (a, b) =>
        b.evLost - a.evLost || b.count - a.count || a.reasonCode.localeCompare(b.reasonCode),
    );
}
