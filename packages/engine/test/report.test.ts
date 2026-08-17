import { describe, expect, it } from 'vitest';

import {
  advanceUntilPlayer,
  assess,
  coach,
  createGame,
  createSession,
  EMPTY_JERK_TALLY,
  flatBettor,
  handTotal,
  PERFECT_POLICY,
  PURE_PLAY,
  roundResults,
  seatResult,
  sessionReport,
  submitAction,
  submitBet,
  submitInsurance,
  VEGAS_STRIP,
  type Action,
  type Choice,
  type Deciders,
  type Decision,
  type GameEvent,
  type JerkTally,
  type ReasonCode,
  type RoundState,
  type SeatConfig,
  type SeatDecider,
  type SessionLog,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

const BANKROLL = 10_000_000;
const BET = 1000;
const ROUNDS = 40;

type SeatSpec = 'player' | 'empty' | 'bot';

function game(seed: number, specs: readonly SeatSpec[]): RoundState {
  const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => {
    const spec = specs[i] ?? 'empty';
    if (spec === 'empty') return { occupant: { kind: 'empty' } as const, bankroll: 0 };
    if (spec === 'player') return { occupant: { kind: 'player' } as const, bankroll: BANKROLL };
    return {
      occupant: { kind: 'bot', policyId: PERFECT_POLICY.id, characterId: `c${i}` } as const,
      bankroll: BANKROLL,
    };
  });
  return createGame({ rules: VEGAS_STRIP, seed, seats });
}

function botDeciders(specs: readonly SeatSpec[]): Deciders {
  const entries: [number, SeatDecider][] = [];
  specs.forEach((spec, index) => {
    if (spec === 'bot') entries.push([index, flatBettor(PERFECT_POLICY, BET)]);
  });
  return new Map(entries);
}

/**
 * How the test player answers. Returning an action not in `legalActions` is a
 * test bug, not a deviation, so every style below picks from the offered list.
 */
type PlayerStyle = {
  /** `null` follows the book — the control. */
  readonly act: ((legal: readonly Action[], total: number, soft: boolean) => Action) | null;
  readonly insure: boolean;
  /** Round numbers the player sits out. */
  readonly sitsOut: ReadonlySet<number>;
};

const NEVER: ReadonlySet<number> = new Set();

const BOOK: PlayerStyle = { act: null, insure: false, sitsOut: NEVER };

/**
 * Hits any pat hand it is allowed to hit. Chosen for the sign test because the
 * loss is unarguable and large — the same device `coach.ts` decision 42 uses,
 * for the same reason: a flipped sign would still produce a plausible report.
 */
const HITS_PAT_HANDS: PlayerStyle = {
  act: (legal, total, soft) =>
    !soft && total >= 17 && legal.includes('hit') ? 'hit' : (legal[0] ?? 'stand'),
  insure: false,
  sitsOut: NEVER,
};

const ALWAYS_INSURES: PlayerStyle = {
  act: (legal) => legal[0] ?? 'stand',
  insure: true,
  sitsOut: NEVER,
};

type Played = {
  readonly decisions: readonly Decision[];
  readonly events: readonly GameEvent[];
  readonly seat: number;
};

/**
 * Drive a real session and log it exactly as the app is expected to: coach once
 * at the prompt, score the tap against that same coaching, and keep every event.
 *
 * Nothing here reaches into `RoundState` to build the log. That is the point —
 * if the report can only be assembled by an app that peeks at engine internals,
 * the module has not actually closed the gap it exists to close.
 */
function play(seed: number, specs: readonly SeatSpec[], style: PlayerStyle): Played {
  const bots = botDeciders(specs);
  const book = flatBettor(PERFECT_POLICY, BET);
  const decisions: Decision[] = [];
  const events: GameEvent[] = [];

  let step = advanceUntilPlayer(createSession(game(seed, specs)), bots);
  const seat = step.session.playerSeat;
  events.push(...step.events);

  for (let guard = 0; guard < 200_000; guard++) {
    const { session, prompt } = step;

    if (prompt.kind === 'bet') {
      if (session.state.roundNumber > ROUNDS) {
        return { decisions, events, seat };
      }
      const sitOut = style.sitsOut.has(session.state.roundNumber);
      step = submitBet(session, sitOut ? 0 : book.bet(prompt.view), bots);
      events.push(...step.events);
      continue;
    }

    const coaching = coach(step, PURE_PLAY);
    if (coaching === null) throw new Error('play: no coaching at a non-bet prompt');

    let choice: Choice;
    if (prompt.kind === 'insurance') {
      choice = { kind: 'insurance', take: style.insure };
    } else if (style.act === null) {
      choice = { kind: 'action', action: book.act(prompt.view) };
    } else {
      const { total, soft } = handTotal(prompt.view.hand.cards);
      choice = { kind: 'action', action: style.act(prompt.view.legalActions, total, soft) };
    }

    decisions.push(assess(coaching, choice));
    step =
      choice.kind === 'insurance'
        ? submitInsurance(session, choice.take, bots)
        : submitAction(session, choice.action, bots);
    events.push(...step.events);
  }
  throw new Error('play: session never finished');
}

function logOf(played: Played, jerk: JerkTally = EMPTY_JERK_TALLY): SessionLog {
  return { decisions: played.decisions, rounds: roundResults(played.events, played.seat), jerk };
}

/** Round numbers in which the seat had a hand settled — computed independently. */
function roundsWithSettlement(events: readonly GameEvent[], seat: number): Set<number> {
  const rounds = new Set<number>();
  let current = 0;
  for (const event of events) {
    if (event.type === 'RoundStarted') current = event.roundNumber;
    else if (event.type === 'HandSettled' && event.ref.seat === seat) rounds.add(current);
    else if (event.type === 'InsuranceSettled' && event.seat === seat) rounds.add(current);
  }
  return rounds;
}

function decision(
  reasonCode: ReasonCode,
  moneyDelta: number,
  wasRecommended = false,
): Decision {
  return {
    choice: { kind: 'action', action: 'hit' },
    wasRecommended,
    reasonCode,
    evDelta: moneyDelta / BET,
    moneyDelta,
  };
}

const EMPTY_LOG: SessionLog = { decisions: [], rounds: [], jerk: EMPTY_JERK_TALLY };

// --- roundResults ----------------------------------------------------------

describe('roundResults', () => {
  it('splits a session into one result per round the seat was dealt into', () => {
    const played = play(41, ['player', 'bot'], BOOK);
    const rounds = roundResults(played.events, played.seat);

    expect(rounds).toHaveLength(roundsWithSettlement(played.events, played.seat).size);
    expect(rounds.length).toBeGreaterThan(0);
    for (const round of rounds) expect(round.seat).toBe(played.seat);
  });

  it('conserves money — the per-round nets sum to the whole stream', () => {
    const played = play(42, ['player', 'bot', 'bot'], HITS_PAT_HANDS);
    const whole = seatResult(played.events, played.seat);
    const perRound = roundResults(played.events, played.seat);

    const summed = perRound.reduce((total, round) => total + round.net, 0);
    expect(summed).toBeCloseTo(whole.net, 9);

    const hands = perRound.reduce((total, round) => total + round.hands.length, 0);
    expect(hands).toBe(whole.hands.length);
  });

  it('never cuts a round in half — no round mixes two rounds of settlements', () => {
    // A seat plays at most four hands (three splits, SPEC §2). A segment holding
    // more than that would mean two rounds landed in one, which is the failure
    // mode a mis-placed `RoundStarted` boundary would produce.
    const played = play(43, ['player', 'bot'], HITS_PAT_HANDS);
    for (const round of roundResults(played.events, played.seat)) {
      expect(round.hands.length).toBeGreaterThan(0);
      expect(round.hands.length).toBeLessThanOrEqual(4);
    }
  });

  it('drops rounds the player sat out', () => {
    const played = play(44, ['player', 'bot'], { ...BOOK, sitsOut: new Set([3, 4, 9]) });
    const rounds = roundResults(played.events, played.seat);

    expect(rounds.length).toBeGreaterThan(0);
    expect(rounds).toHaveLength(roundsWithSettlement(played.events, played.seat).size);
    // The bot kept playing, so the rounds happened; the player just was not in them.
    expect(rounds.length).toBeLessThan(ROUNDS);
  });

  it('keeps events that precede the first RoundStarted rather than discarding them', () => {
    const played = play(45, ['player'], BOOK);
    const first = played.events.findIndex((event) => event.type === 'RoundStarted');
    expect(first).toBeGreaterThanOrEqual(0);

    // Slicing mid-stream simulates a caller that only kept part of the session.
    const tail = played.events.slice(first + 1);
    const fromTail = roundResults(tail, played.seat);
    const wholeTail = seatResult(tail, played.seat);
    const summed = fromTail.reduce((total, round) => total + round.net, 0);
    expect(summed).toBeCloseTo(wholeTail.net, 9);
  });
});

// --- The report ------------------------------------------------------------

describe('sessionReport', () => {
  it('totals money from the rounds, independently of the decision log', () => {
    const played = play(46, ['player', 'bot'], HITS_PAT_HANDS);
    const rounds = roundResults(played.events, played.seat);
    const report = sessionReport(logOf(played));

    expect(report.roundsPlayed).toBe(rounds.length);
    expect(report.handsPlayed).toBe(seatResult(played.events, played.seat).hands.length);
    expect(report.handsPlayed).toBeGreaterThanOrEqual(report.roundsPlayed);
    expect(report.net).toBeCloseTo(seatResult(played.events, played.seat).net, 9);

    const nets = rounds.map((round) => round.net);
    expect(report.biggestWin).toBe(Math.max(0, ...nets));
    expect(report.biggestLoss).toBe(Math.min(0, ...nets));
    // Signed, not a magnitude — a screen must never have to guess.
    expect(report.biggestLoss).toBeLessThanOrEqual(0);
    expect(report.biggestWin).toBeGreaterThanOrEqual(0);
  });

  it('counts decisions and accuracy over the log it was given', () => {
    const played = play(47, ['player', 'bot'], HITS_PAT_HANDS);
    const report = sessionReport(logOf(played));

    const followed = played.decisions.filter((d) => d.wasRecommended).length;
    expect(report.decisionsMade).toBe(played.decisions.length);
    expect(report.deviations).toBe(played.decisions.length - followed);
    expect(report.accuracy).toBeCloseTo(followed / played.decisions.length, 12);
    expect(report.deviations).toBeGreaterThan(0);
  });

  it('reports evLost as the negated sum of every decision', () => {
    const played = play(48, ['player', 'bot'], HITS_PAT_HANDS);
    const report = sessionReport(logOf(played));

    const summed = played.decisions.reduce((total, d) => total + d.moneyDelta, 0);
    expect(report.evLost).toBeCloseTo(-summed, 9);
  });

  it('partitions the deviations exactly — mistakes sum to the deviations and to evLost', () => {
    const played = play(49, ['player', 'bot', 'bot'], HITS_PAT_HANDS);
    const report = sessionReport(logOf(played));

    const counted = report.mistakes.reduce((total, m) => total + m.count, 0);
    const cost = report.mistakes.reduce((total, m) => total + m.evLost, 0);
    expect(counted).toBe(report.deviations);
    expect(cost).toBeCloseTo(report.evLost, 9);
    expect(report.mistakes.length).toBeGreaterThan(0);
  });

  it('passes the jerk tally through untouched', () => {
    const played = play(50, ['player', 'bot'], BOOK);
    const tally: JerkTally = { helped: 7, hurt: 5, unchanged: 88, netDelta: -1250 };
    expect(sessionReport(logOf(played, tally)).jerk).toEqual(tally);
  });
});

// --- The sign, pinned ------------------------------------------------------

describe('the sign of evLost', () => {
  /**
   * The control. Playing the book must cost *exactly* zero, not merely something
   * small — the same bar `bots.test.ts` sets on its paired comparisons (PLAN
   * decision 31). If a followed recommendation ever contributed a nonzero
   * `moneyDelta`, every other assertion in this file would still pass while the
   * report quietly charged the player for playing correctly.
   */
  it('costs exactly nothing to play the book', () => {
    const played = play(51, ['player', 'bot'], BOOK);
    const report = sessionReport(logOf(played));

    expect(report.decisionsMade).toBeGreaterThan(0);
    expect(report.deviations).toBe(0);
    expect(report.accuracy).toBe(1);
    expect(report.evLost).toBe(0);
    expect(report.mistakes).toEqual([]);
  });

  it('charges a player who hits pat hands, and charges them a lot', () => {
    const played = play(52, ['player', 'bot'], HITS_PAT_HANDS);
    const report = sessionReport(logOf(played));

    expect(report.deviations).toBeGreaterThan(0);
    expect(report.evLost).toBeGreaterThan(0);
    // Hitting a hard pat hand gives up more than half a bet each time; the
    // threshold is deliberately loose, because the assertion is about the sign
    // and the order of magnitude, not about this seed.
    expect(report.evLost).toBeGreaterThan(0.5 * BET * report.deviations);
  });

  it('charges a player who always insures', () => {
    const played = play(53, ['player', 'bot', 'bot'], ALWAYS_INSURES);
    const insured = played.decisions.filter((d) => d.choice.kind === 'insurance' && d.choice.take);
    expect(insured.length).toBeGreaterThan(0);

    const report = sessionReport({
      decisions: insured,
      rounds: roundResults(played.events, played.seat),
      jerk: EMPTY_JERK_TALLY,
    });
    expect(report.deviations).toBe(insured.length);
    expect(report.evLost).toBeGreaterThan(0);
  });
});

// --- Ranking and edges -----------------------------------------------------

describe('mistake ranking', () => {
  it('ranks by money, not by frequency', () => {
    const report = sessionReport({
      ...EMPTY_LOG,
      decisions: [
        decision('CLOSEST_CALL', -5),
        decision('CLOSEST_CALL', -5),
        decision('CLOSEST_CALL', -5),
        decision('DEALER_STRONG_MUST_IMPROVE', -400),
      ],
    });

    expect(report.mistakes.map((m) => m.reasonCode)).toEqual([
      'DEALER_STRONG_MUST_IMPROVE',
      'CLOSEST_CALL',
    ]);
    expect(report.mistakes[0]?.evLost).toBeCloseTo(400, 9);
    expect(report.mistakes[1]?.count).toBe(3);
  });

  it('breaks ties on count, then on the code, so the ranking is total', () => {
    const report = sessionReport({
      ...EMPTY_LOG,
      decisions: [
        decision('NEVER_SPLIT_TENS', -100),
        decision('ALWAYS_SPLIT_EIGHTS', -50),
        decision('ALWAYS_SPLIT_EIGHTS', -50),
        decision('SOFT_HAND_CANT_BUST', -100),
      ],
    });

    // All three cost exactly 100; ALWAYS_SPLIT_EIGHTS has two, so it leads, and
    // the remaining pair falls back to the code itself.
    expect(report.mistakes.map((m) => m.reasonCode)).toEqual([
      'ALWAYS_SPLIT_EIGHTS',
      'NEVER_SPLIT_TENS',
      'SOFT_HAND_CANT_BUST',
    ]);
  });

  it('excludes followed recommendations from the mistake list', () => {
    const report = sessionReport({
      ...EMPTY_LOG,
      decisions: [
        decision('DEALER_WEAK_LET_THEM_BUST', 0, true),
        decision('DEALER_WEAK_LET_THEM_BUST', -200),
      ],
    });

    expect(report.mistakes).toHaveLength(1);
    expect(report.mistakes[0]).toEqual({
      reasonCode: 'DEALER_WEAK_LET_THEM_BUST',
      count: 1,
      evLost: 200,
    });
  });

  it('does not clamp a deviation that gained', () => {
    // The composition-dependent cells are real (PLAN, cross-validation), and a
    // report that hid them would be lying in the app's own favour.
    const report = sessionReport({
      ...EMPTY_LOG,
      decisions: [decision('DAMAGE_CONTROL', +30)],
    });

    expect(report.evLost).toBeCloseTo(-30, 9);
    expect(report.mistakes[0]?.evLost).toBeCloseTo(-30, 9);
    expect(report.deviations).toBe(1);
  });
});

describe('an empty session', () => {
  it('reports no accuracy rather than perfect accuracy', () => {
    const report = sessionReport(EMPTY_LOG);

    expect(report.accuracy).toBeNull();
    expect(report.decisionsMade).toBe(0);
    expect(report.deviations).toBe(0);
    expect(report.roundsPlayed).toBe(0);
    expect(report.handsPlayed).toBe(0);
    expect(report.net).toBe(0);
    expect(report.biggestWin).toBe(0);
    expect(report.biggestLoss).toBe(0);
    expect(report.evLost).toBe(0);
    expect(report.mistakes).toEqual([]);
    expect(report.jerk).toEqual(EMPTY_JERK_TALLY);
  });

  it('reports accuracy 1 only when decisions were actually made', () => {
    const report = sessionReport({
      ...EMPTY_LOG,
      decisions: [decision('ALWAYS_SPLIT_ACES', 0, true)],
    });
    expect(report.accuracy).toBe(1);
  });
});
