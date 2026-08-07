import { describe, expect, it } from 'vitest';

import { compositionOf, type Card, type Rank, type Shoe, type Suit } from '../src/cards.js';
import { eventsOfType, type GameEvent } from '../src/events.js';
import {
  addToTally,
  advanceUntilDecision,
  counterfactual,
  createGame,
  createHand,
  EMPTY_JERK_TALLY,
  flatBettor,
  PERFECT_POLICY,
  placeBets,
  playRound,
  playRounds,
  policyById,
  recordRound,
  replayRound,
  seatAt,
  seatResult,
  VEGAS_STRIP,
  type BotPolicy,
  type Counterfactual,
  type Deciders,
  type RoundRecording,
  type RoundState,
  type SeatConfig,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

const BANKROLL = 100_000;
const BET = 10;

type SeatSpec = 'player' | 'empty' | BotPolicy;

function game(seed: number, specs: readonly SeatSpec[], bankroll = BANKROLL): RoundState {
  const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => {
    const spec = specs[i] ?? 'empty';
    if (spec === 'empty') return { occupant: { kind: 'empty' } as const, bankroll: 0 };
    if (spec === 'player') return { occupant: { kind: 'player' } as const, bankroll };
    return { occupant: { kind: 'bot', policyId: spec.id, characterId: `c${i}` } as const, bankroll };
  });
  return createGame({ rules: VEGAS_STRIP, seed, seats });
}

function decidersFor(specs: readonly SeatSpec[], bet = BET): Deciders {
  const map = new Map<number, ReturnType<typeof flatBettor>>();
  specs.forEach((spec, i) => {
    if (spec === 'empty') return;
    map.set(i, flatBettor(spec === 'player' ? PERFECT_POLICY : spec, bet));
  });
  return map;
}

/** One played round plus everything needed to replay it. */
type PlayedRound = {
  readonly recording: RoundRecording;
  readonly events: readonly GameEvent[];
  readonly state: RoundState;
};

/** Play `rounds` rounds, snapshotting each one at its betting phase. */
function* playedRounds(
  seed: number,
  specs: readonly SeatSpec[],
  rounds: number,
  bet = BET,
): Generator<PlayedRound> {
  const deciders = decidersFor(specs, bet);
  let state = game(seed, specs);
  for (let i = 0; i < rounds; i++) {
    // The recording starts from the betting phase with nothing staked, so the
    // replay makes the same bets from the same bankrolls.
    const betting = advanceUntilDecision(state).state;
    const played = playRound(betting, deciders);
    yield {
      recording: recordRound(betting, played.events),
      events: played.events,
      state: played.state,
    };
    state = played.state;
  }
}

/** Build a shoe with a known card order. One seat: p1, dealer up, p2, hole. */
function stack(ranks: readonly string[]): Shoe {
  const suits: readonly Suit[] = ['S', 'H', 'D', 'C'];
  const cards: Card[] = ranks.map((rank, i) => ({
    rank: rank as Rank,
    suit: suits[i % 4] as Suit,
    id: `${rank}-${i}`,
  }));
  return {
    cards,
    index: 0,
    cutIndex: cards.length, // never reached, so nothing reshuffles mid-test
    deckCount: VEGAS_STRIP.deckCount,
    composition: compositionOf(cards),
  };
}

const NO_OVERRIDES = new Map<number, BotPolicy>();

// --- The property the whole demo rests on ----------------------------------

describe('a replay with nothing overridden reproduces the round exactly', () => {
  it('matches event for event and byte for byte across many seeds and tables', () => {
    // The tables are deliberately mixed: perfect play alone splits and doubles
    // rarely, and a replay that only ever reproduced stand/hit would prove
    // nothing about the actions that move money.
    const tables: readonly (readonly SeatSpec[])[] = [
      ['player'],
      ['player', policyById('mimics-dealer')],
      [policyById('doubles-twelve'), 'player', policyById('always-insures')],
      ['player', policyById('never-splits'), PERFECT_POLICY, policyById('hits-every-16')],
    ];

    let rounds = 0;
    let splits = 0;
    let doubles = 0;
    let insurance = 0;

    for (const [index, specs] of tables.entries()) {
      for (const played of playedRounds(1000 + index, specs, 120)) {
        const replayed = replayRound(played.recording, NO_OVERRIDES);
        expect(JSON.stringify(replayed.events)).toEqual(JSON.stringify(played.events));
        expect(JSON.stringify(replayed.state)).toEqual(JSON.stringify(played.state));

        rounds++;
        if (eventsOfType(played.events, 'HandSplit').length > 0) splits++;
        if (eventsOfType(played.events, 'HandDoubled').length > 0) doubles++;
        if (eventsOfType(played.events, 'InsuranceTaken').length > 0) insurance++;
      }
    }

    expect(rounds).toBe(480);
    // Without these the test could pass having replayed 480 rounds of nothing
    // but stand.
    expect(splits).toBeGreaterThan(5);
    expect(doubles).toBeGreaterThan(30);
    expect(insurance).toBeGreaterThan(5);
  });

  it('reproduces the bankrolls, not merely the narration', () => {
    for (const played of playedRounds(2024, ['player', policyById('doubles-twelve')], 60)) {
      const replayed = replayRound(played.recording, NO_OVERRIDES);
      for (const seatIndex of [0, 1]) {
        expect(seatAt(replayed.state, seatIndex).bankroll).toBe(
          seatAt(played.state, seatIndex).bankroll,
        );
      }
    }
  });

  it('is repeatable: replaying the same recording twice gives the same answer', () => {
    // The scripted decider holds a cursor, so it is stateful. It is built fresh
    // inside every call and never escapes, which is what keeps `replayRound` a
    // pure function of its arguments.
    for (const played of playedRounds(4242, ['player', policyById('mimics-dealer')], 40)) {
      const first = replayRound(played.recording, NO_OVERRIDES);
      const second = replayRound(played.recording, NO_OVERRIDES);
      expect(JSON.stringify(first.events)).toEqual(JSON.stringify(second.events));
    }
  });

  it('leaves the recorded start state untouched', () => {
    for (const played of playedRounds(55, ['player', policyById('never-splits')], 20)) {
      const before = JSON.stringify(played.recording.state);
      replayRound(played.recording, new Map([[1, PERFECT_POLICY]]));
      expect(JSON.stringify(played.recording.state)).toEqual(before);
    }
  });
});

// --- What a recording is allowed to be -------------------------------------

describe('recordRound refuses a recording it could not replay', () => {
  const specs: readonly SeatSpec[] = ['player', policyById('mimics-dealer')];

  it('refuses a state that is not at the betting phase', () => {
    const betting = advanceUntilDecision(game(1, specs)).state;
    const dealt = advanceUntilDecision(placeBets(betting, new Map([[0, BET]])).state).state;
    expect(dealt.phase).not.toBe('betting');
    expect(() => recordRound(dealt, [])).toThrow(/expected the betting phase/);
  });

  it('refuses a state whose bets are already placed', () => {
    // A snapshot taken after `placeBets` would replay from a table that had
    // already staked money, and every bankroll in the comparison would be off
    // by one round's bets.
    const betting = advanceUntilDecision(game(2, specs)).state;
    const staked: RoundState = {
      ...betting,
      seats: betting.seats.map((seat) =>
        seat.index === 0 ? { ...seat, baseBet: BET, hands: [createHand([], BET)] } : seat,
      ),
    };
    expect(staked.phase).toBe('betting');
    expect(() => recordRound(staked, [])).toThrow(/bets are already placed/);
  });

  it('refuses an event list that spans more than one round', () => {
    // A seat that bet twice is the only observable signature of a two-round
    // event list, and replaying one would be nonsense rather than an error.
    const betting = advanceUntilDecision(game(3, specs)).state;
    const twoRounds = playRounds(betting, decidersFor(specs), 2).events;
    expect(() => recordRound(betting, twoRounds)).toThrow(/bet twice/);
    expect(() => recordRound(betting, twoRounds)).toThrow(/span more than one round/);
  });

  it('keeps every decision anyone made, in the order they made them', () => {
    const [played] = [...playedRounds(4, specs, 1)];
    if (played === undefined) throw new Error('no round was played');

    const bets = played.recording.decisions.filter((decision) => decision.kind === 'bet');
    const actions = played.recording.decisions.filter((decision) => decision.kind === 'action');
    expect(bets).toHaveLength(2);
    expect(actions.map((action) => action.action)).toEqual(
      eventsOfType(played.events, 'PlayerActed').map((event) => event.action),
    );
    expect(played.recording.roundNumber).toBe(played.recording.state.roundNumber);
  });
});

// --- Substituting a policy --------------------------------------------------

describe('overriding a seat', () => {
  it('changes how a jerk plays, and therefore what the rest of the table sees', () => {
    const specs: readonly SeatSpec[] = ['player', policyById('mimics-dealer')];
    let changed = 0;
    let compared = 0;

    for (const played of playedRounds(20260807, specs, 200)) {
      const replayed = replayRound(played.recording, new Map([[1, PERFECT_POLICY]]));
      compared++;
      if (JSON.stringify(replayed.events) !== JSON.stringify(played.events)) changed++;
    }

    expect(compared).toBe(200);
    // The mimic deviates from the book on about a fifth of its hands, so a
    // substantial fraction of rounds must play out differently. Zero here would
    // mean the override was never actually applied.
    expect(changed).toBeGreaterThan(50);
  });

  it('changes nothing when the seat was already playing the book', () => {
    // The corrected replay of a correct player is the original round. This is
    // what makes the §7 demo's "unchanged" verdict trustworthy: it means the
    // jerk's play genuinely did not matter, not that the replay is inert.
    const specs: readonly SeatSpec[] = ['player', PERFECT_POLICY, PERFECT_POLICY];
    for (const played of playedRounds(31415, specs, 150)) {
      const replayed = replayRound(played.recording, new Map([[1, PERFECT_POLICY]]));
      expect(JSON.stringify(replayed.events)).toEqual(JSON.stringify(played.events));
    }
  });

  it('keeps the recorded stake even for the seat it is correcting', () => {
    // Changing the bet would move money for a reason that has nothing to do
    // with how the hand was played, and the comparison is about play.
    const specs: readonly SeatSpec[] = ['player', policyById('mimics-dealer')];
    for (const played of playedRounds(6, specs, 30, 25)) {
      const replayed = replayRound(played.recording, new Map([[1, PERFECT_POLICY]]));
      const bets = eventsOfType(replayed.events, 'BetPlaced');
      expect(bets.map((event) => [event.seat, event.amount])).toEqual([
        [0, 25],
        [1, 25],
      ]);
    }
  });
});

// --- The divergence contract ------------------------------------------------

describe('a scripted seat abandons the script the moment it stops fitting', () => {
  /**
   * Player T,6 = hard 16; dealer 6,K = 16 and must draw. The book stands the
   * player's 16 against a 6, so standing and hitting are trivially told apart:
   * standing leaves two cards and loses, hitting catches the 5 for 21 and pushes.
   */
  const SHOE = stack(['T', '6', '6', 'K', '5', '5', '5', '5']);

  function bettingState(): RoundState {
    const start = { ...game(9, ['player']), shoe: SHOE };
    return advanceUntilDecision(start).state;
  }

  function recordingWith(decisions: RoundRecording['decisions']): RoundRecording {
    const state = bettingState();
    return { state, roundNumber: state.roundNumber, decisions };
  }

  const playerCards = (events: readonly GameEvent[]): number =>
    eventsOfType(events, 'CardDealt').filter((event) => event.seat === 0).length;

  it('follows a script that fits, even when the script is a mistake', () => {
    // Hitting a 16 against a 6 is not the book answer. A recording of a real
    // player has to be replayable as it happened, mistakes included.
    const replayed = replayRound(
      recordingWith([
        { kind: 'bet', seat: 0, amount: BET },
        { kind: 'action', seat: 0, handIndex: 0, action: 'hit' },
      ]),
      NO_OVERRIDES,
    );
    expect(eventsOfType(replayed.events, 'PlayerActed').map((event) => event.action)).toEqual([
      'hit',
    ]);
    expect(playerCards(replayed.events)).toBe(3);
  });

  it('falls back to the book when the recorded action is no longer legal', () => {
    // T,6 is not a pair, so the recorded split cannot be taken. The cards have
    // diverged from whatever produced this script, and every later entry
    // describes a hand that no longer exists.
    const replayed = replayRound(
      recordingWith([
        { kind: 'bet', seat: 0, amount: BET },
        { kind: 'action', seat: 0, handIndex: 0, action: 'split' },
      ]),
      NO_OVERRIDES,
    );
    expect(eventsOfType(replayed.events, 'PlayerActed').map((event) => event.action)).toEqual([
      'stand',
    ]);
    expect(playerCards(replayed.events)).toBe(2);
  });

  it('never resumes the script, even when a later entry would have fitted', () => {
    // The first entry names hand 1, which does not exist yet, so the seat
    // diverges. The second entry fits hand 0 perfectly — and must be ignored,
    // because a script that is right again by coincidence is worse than one
    // that is honestly gone.
    const replayed = replayRound(
      recordingWith([
        { kind: 'bet', seat: 0, amount: BET },
        { kind: 'action', seat: 0, handIndex: 1, action: 'hit' },
        { kind: 'action', seat: 0, handIndex: 0, action: 'hit' },
      ]),
      NO_OVERRIDES,
    );
    expect(eventsOfType(replayed.events, 'PlayerActed').map((event) => event.action)).toEqual([
      'stand',
    ]);
    expect(playerCards(replayed.events)).toBe(2);
  });
});

// --- Reading a seat's round out of the events -------------------------------

describe('seatResult', () => {
  const settled = (
    seat: number,
    handIndex: number,
    net: number,
    bet = 10,
  ): GameEvent => ({
    type: 'HandSettled',
    ref: { seat, handIndex },
    outcome: net > 0 ? 'win' : net < 0 ? 'lose' : 'push',
    bet,
    payout: net + bet,
    net,
  });

  it('totals every hand the seat held, and nobody else’s', () => {
    const events: GameEvent[] = [
      settled(0, 0, 15),
      settled(1, 0, -10),
      settled(0, 1, -10),
      settled(0, 2, 0),
      settled(2, 0, 10),
    ];
    const result = seatResult(events, 0);
    expect(result.seat).toBe(0);
    expect(result.hands.map((hand) => hand.handIndex)).toEqual([0, 1, 2]);
    expect(result.net).toBe(5);
    expect(result.insuranceNet).toBe(0);
  });

  it('folds insurance into the net and reports it separately as well', () => {
    const events: GameEvent[] = [
      { type: 'InsuranceSettled', seat: 0, bet: 5, payout: 15, net: 10 },
      settled(0, 0, -10),
      { type: 'InsuranceSettled', seat: 1, bet: 5, payout: 0, net: -5 },
    ];
    const result = seatResult(events, 0);
    expect(result.insuranceNet).toBe(10);
    expect(result.net).toBe(0); // the classic insurance wash
    expect(result.hands).toHaveLength(1);
  });

  it('reports an empty round for a seat that was not in it', () => {
    expect(seatResult([settled(1, 0, 10)], 0)).toEqual({
      seat: 0,
      net: 0,
      hands: [],
      insuranceNet: 0,
    });
  });

  it('agrees with the bankroll a real round actually moved', () => {
    const specs: readonly SeatSpec[] = ['player', policyById('always-insures')];
    let previous = game(77, specs);
    for (const played of playedRounds(77, specs, 120)) {
      for (const seatIndex of [0, 1]) {
        const moved = seatAt(played.state, seatIndex).bankroll - seatAt(previous, seatIndex).bankroll;
        expect(seatResult(played.events, seatIndex).net, `seat ${seatIndex}`).toBe(moved);
      }
      previous = played.state;
    }
  });
});

// --- The sign of the answer -------------------------------------------------

/**
 * The seed and seats behind the two concrete rounds pinned below. The player is
 * at first base and the jerk sits behind them, which is the arrangement SPEC §7
 * is about: the jerk's extra cards cannot reach the player's hand, only the
 * dealer's.
 */
const DEMO_SPECS: readonly SeatSpec[] = ['player', policyById('mimics-dealer')];
const DEMO_SEED = 20260807;

function demoRound(roundNumber: number): Counterfactual {
  for (const played of playedRounds(DEMO_SEED, DEMO_SPECS, roundNumber)) {
    if (played.recording.roundNumber !== roundNumber) continue;
    return counterfactual(played.recording, played.events, {
      correctedSeat: 1,
      observedSeat: 0,
    });
  }
  throw new Error(`round ${roundNumber} was never played`);
}

describe('delta is corrected minus actual, and the verdict follows its sign', () => {
  it('calls it "hurt" when playing correctly would have paid the player more', () => {
    // Round 63: the player lost $20 as it happened, and would have won $20 had
    // the mimic played the book. Correcting the jerk *improves* the player's
    // result, so the jerk's real play cost them money.
    const result = demoRound(63);
    expect(result.actual.net).toBe(-20);
    expect(result.corrected.net).toBe(20);
    expect(result.delta).toBe(40);
    expect(result.delta).toBe(result.corrected.net - result.actual.net);
    expect(result.verdict).toBe('hurt');
  });

  it('calls it "helped" when playing correctly would have paid the player less', () => {
    // Round 2: the player pushed as it happened and would have lost $10 had the
    // mimic played the book. The bad play was worth $10 to them.
    const result = demoRound(2);
    expect(result.actual.net).toBe(0);
    expect(result.corrected.net).toBe(-10);
    expect(result.delta).toBe(-10);
    expect(result.verdict).toBe('helped');
  });

  it('calls it "unchanged" only when the money is genuinely identical', () => {
    let unchanged = 0;
    for (const played of playedRounds(DEMO_SEED, DEMO_SPECS, 80)) {
      const result = counterfactual(played.recording, played.events, {
        correctedSeat: 1,
        observedSeat: 0,
      });
      if (result.verdict !== 'unchanged') continue;
      unchanged++;
      expect(result.delta).toBe(0);
      expect(result.corrected.net).toBe(result.actual.net);
    }
    expect(unchanged).toBeGreaterThan(40);
  });

  it('reports both sides, so the UI can show them next to each other', () => {
    const result = demoRound(63);
    expect(result.correctedSeat).toBe(1);
    expect(result.observedSeat).toBe(0);
    expect(result.actual.seat).toBe(0);
    expect(result.corrected.seat).toBe(0);
    expect(result.events.length).toBeGreaterThan(0);
    expect(eventsOfType(result.events, 'HandSettled').length).toBeGreaterThan(0);
  });

  it('refuses to replay the observed seat against itself', () => {
    const [played] = [...playedRounds(DEMO_SEED, DEMO_SPECS, 1)];
    if (played === undefined) throw new Error('no round was played');
    expect(() =>
      counterfactual(played.recording, played.events, { correctedSeat: 0, observedSeat: 0 }),
    ).toThrow(/the same/);
    expect(() =>
      counterfactual(played.recording, played.events, { correctedSeat: 0, observedSeat: 0 }),
    ).toThrow(/a different question/);
  });

  it('can correct a seat to a different bad habit, not only to the book', () => {
    const [played] = [...playedRounds(DEMO_SEED, DEMO_SPECS, 1)];
    if (played === undefined) throw new Error('no round was played');
    const book = counterfactual(played.recording, played.events, {
      correctedSeat: 1,
      observedSeat: 0,
    });
    const other = counterfactual(played.recording, played.events, {
      correctedSeat: 1,
      observedSeat: 0,
      policy: policyById('doubles-twelve'),
    });
    expect(book.correctedSeat).toBe(other.correctedSeat);
    // Both are legitimate answers to different questions; the point is only that
    // the policy is a parameter and the default is the book.
    expect(typeof other.delta).toBe('number');
  });
});

// --- The lesson (SPEC §7) ---------------------------------------------------

describe('the third-base myth, measured', () => {
  it('helps about as often as it hurts, and costs about nothing on balance', () => {
    // The claim SPEC §7 makes is not that a bad player is harmless in some
    // hand-wavy sense — it is that their bad plays are *exactly as likely* to
    // help you as to hurt you. Both tolerances below are standard errors of this
    // sample rather than constants, following `sim.slow.test.ts`, so shrinking
    // the run stays honest instead of flaky. `replay.slow.test.ts` runs ten
    // times as many rounds for a tighter figure.
    const ROUNDS = 20_000;
    const BET_SIZE = 5;

    let tally = EMPTY_JERK_TALLY;
    let sumSquares = 0;

    for (const played of playedRounds(DEMO_SEED, DEMO_SPECS, ROUNDS, BET_SIZE)) {
      const result = counterfactual(played.recording, played.events, {
        correctedSeat: 1,
        observedSeat: 0,
      });
      tally = addToTally(tally, result);
      sumSquares += result.delta * result.delta;
    }

    const changed = tally.helped + tally.hurt;
    expect(changed).toBeGreaterThan(1000);

    // Under the myth's own claim — that a bad play is a coin flip for you — the
    // gap between helped and hurt is a binomial with standard error √changed.
    const countError = Math.sqrt(changed);
    expect(Math.abs(tally.helped - tally.hurt)).toBeLessThan(3 * countError);

    // And the money says the same thing. The standard error of the summed delta
    // is √(Σδ²) once the mean is negligible, which is exactly the hypothesis.
    const deltaError = Math.sqrt(sumSquares);
    expect(Math.abs(tally.netDelta)).toBeLessThan(3 * deltaError);

    // Stated the way a player would ask it: on $100,000 of action, the jerk
    // moved well under one percent of it in either direction.
    const wagered = ROUNDS * BET_SIZE;
    expect(Math.abs(tally.netDelta) / wagered).toBeLessThan(0.01);
  }, 60_000);
});

// --- The tally --------------------------------------------------------------

describe('addToTally', () => {
  const verdictOf = (delta: number): Counterfactual => ({
    correctedSeat: 1,
    observedSeat: 0,
    actual: { seat: 0, net: 0, hands: [], insuranceNet: 0 },
    corrected: { seat: 0, net: delta, hands: [], insuranceNet: 0 },
    delta,
    verdict: delta === 0 ? 'unchanged' : delta > 0 ? 'hurt' : 'helped',
    events: [],
  });

  it('starts from zero on every axis', () => {
    expect(EMPTY_JERK_TALLY).toEqual({ helped: 0, hurt: 0, unchanged: 0, netDelta: 0 });
  });

  it('counts one verdict and adds one delta per call', () => {
    let tally = EMPTY_JERK_TALLY;
    for (const delta of [40, -10, 0, 5, -5, -2.5]) tally = addToTally(tally, verdictOf(delta));
    expect(tally).toEqual({ helped: 3, hurt: 2, unchanged: 1, netDelta: 27.5 });
  });

  it('does not mutate the tally it is given, so a session log can keep snapshots', () => {
    const start = EMPTY_JERK_TALLY;
    const next = addToTally(start, verdictOf(40));
    expect(start).toEqual({ helped: 0, hurt: 0, unchanged: 0, netDelta: 0 });
    expect(next).not.toBe(start);
  });

  it('keeps the money alongside the counts, because the counts alone can mislead', () => {
    // Many small helps and one large hurt is a real pattern, and "helped 3,
    // hurt 1" would hide it entirely.
    let tally = EMPTY_JERK_TALLY;
    for (const delta of [-5, -5, -5, 60]) tally = addToTally(tally, verdictOf(delta));
    expect(tally.helped).toBe(3);
    expect(tally.hurt).toBe(1);
    expect(tally.netDelta).toBe(45); // the jerk cost money despite helping more often
  });
});
