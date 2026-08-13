/**
 * The third-base myth demo, as the app wires it (SPEC §7).
 *
 * The engine's half is proved in `replay.test.ts` and `replay.slow.test.ts` —
 * that a counterfactual reproduces the round, that `delta`'s sign matches its
 * verdict, and that over 100,000 rounds helped ≈ hurt. None of that is re-tested
 * here. What is checked is the four things the *app* decides, each of which
 * throws nothing and looks entirely plausible on screen when wrong:
 *
 * 1. **The tally counts every completed round, not the ones the player asked
 *    about.** The prompt only appears after a loss, so a tap-driven tally
 *    samples losses and converges on "hurt" — it would teach the myth the demo
 *    exists to refute, with every number on it looking reasonable.
 * 2. **It advances on the draw clock**, like `log` and unlike `decisions`
 *    (decision 64). A §7 verdict is about money that has already changed hands,
 *    so counting it at the tap would report the round while the felt still
 *    showed the hand live.
 * 3. **The seating chart and the deciders agree about who the jerk is.** They
 *    are derived separately, and a table where the label and the play come apart
 *    is a table where the demo names the wrong seat.
 * 4. **Turning Jerk Mode on moves no cards** (M3 decision 23). That is the
 *    property that makes the comparison a comparison rather than two unrelated
 *    shoes, and it is the app's job not to break it by threading the flag into
 *    the wrong seed.
 */

import {
  EMPTY_JERK_TALLY,
  PERFECT_POLICY,
  VEGAS_STRIP,
  type Action,
  type Counterfactual,
  type GameEvent,
} from '@bj/engine';
import { describe, expect, it } from 'vitest';

import {
  act,
  bet,
  botDeciders,
  DEFAULT_CONFIG,
  drawAll,
  drawNext,
  insure,
  jerkAt,
  openTableState,
  revealCheck,
  seating,
  tally,
  type TableConfig,
  type TableState,
} from '../src/table/tableState';

const BET = 5;

const JERK_ON: TableConfig = { ...DEFAULT_CONFIG, jerkMode: true };
const JERK_OFF: TableConfig = { ...DEFAULT_CONFIG, jerkMode: false };

// --- Driving ---------------------------------------------------------------

/** Drain the queue one event at a time, as the clock does. */
function drain(state: TableState): TableState {
  let current = state;
  while (current.pending.length > 0) current = drawNext(current);
  return current;
}

function book(state: TableState): Action {
  if (state.coaching === null || state.coaching.kind !== 'action') {
    throw new Error('book: not an action prompt');
  }
  return state.coaching.recommendation.action;
}

/** Answer whatever is being asked. Does **not** drain afterwards — see test 2. */
function submit(state: TableState, config: TableConfig, deciders = botDeciders(config)): TableState {
  const settings = config.coachSettings;
  switch (state.prompt.kind) {
    case 'bet':
      return bet(state, state.prompt.max < state.prompt.min ? 0 : BET, deciders, settings);
    case 'insurance':
      return insure(state, false, deciders, settings);
    case 'action':
      return act(state, book(state), deciders, settings);
  }
}

/** Play `rounds` rounds of book play, drawing everything, as a player would. */
function play(config: TableConfig, rounds: number): TableState {
  const deciders = botDeciders(config);
  let state = drain(openTableState(config, deciders));
  for (let i = 0; i < rounds * 40; i += 1) {
    if (state.felt.roundNumber > rounds) break;
    state = drain(submit(state, config, deciders));
  }
  return state;
}

/** How many rounds the felt has seen through to the end. */
function roundsDrawn(log: readonly GameEvent[]): number {
  return log.filter((event) => event.type === 'RoundStarted').length - 1;
}

/** The lowest seed at or above `from` whose jerk plays `policyId`. */
function seedWhoseJerkIs(policyId: string, from = 1): number {
  for (let seed = from; seed < from + 500; seed += 1) {
    if (jerkAt({ ...JERK_ON, seed })?.policy.id === policyId) return seed;
  }
  throw new Error(`no seed within 500 assigns "${policyId}"`);
}

/** Drive a session, keeping every offer the app made along the way. */
function playCollectingOffers(
  config: TableConfig,
  rounds: number,
): { readonly state: TableState; readonly offers: readonly Counterfactual[] } {
  const deciders = botDeciders(config);
  let state = drain(openTableState(config, deciders));
  const offers: Counterfactual[] = [];

  for (let i = 0; i < rounds * 40; i += 1) {
    if (state.felt.roundNumber > rounds) break;
    const next = drain(submit(state, config, deciders));
    if (next.jerkCheck !== null && next.jerkCheck !== state.jerkCheck) {
      offers.push(next.jerkCheck.result);
    }
    state = next;
  }
  return { state, offers };
}

/**
 * 300 rounds against `mimics-dealer`, driven once and read by two tests.
 *
 * **The habit is chosen by name, not taken from the default seed.** PLAN's §7
 * figure — the jerk moved the player's outcome ~9% of the time — was measured
 * with this one. The other five are far quieter, and the default seed happens
 * to draw the quietest card-consuming habit of the six: `stands-on-soft-17`
 * fires only on a soft 17 and changes the player's result in **1 round out of
 * 300**. A verdict test seeded there sees nothing but `unchanged`, asserts
 * nothing, and goes green — decision 68's failure mode exactly.
 */
const LOUD_SESSION = playCollectingOffers(
  { ...JERK_ON, seed: seedWhoseJerkIs('mimics-dealer') },
  300,
);

// --- 3. The chart and the deciders agree -----------------------------------

describe('who plays badly', () => {
  it('is nobody at all with Jerk Mode off', () => {
    expect(jerkAt(JERK_OFF)).toBeNull();
    for (const index of JERK_OFF.botSeats) {
      const occupant = seating(JERK_OFF)[index]?.occupant;
      expect(occupant?.kind === 'bot' ? occupant.policyId : null).toBe(PERFECT_POLICY.id);
    }
  });

  it('is exactly one bot seat, and never the player', () => {
    const jerk = jerkAt(JERK_ON);
    expect(jerk).not.toBeNull();
    expect(JERK_ON.botSeats).toContain(jerk?.seat);
    expect(jerk?.seat).not.toBe(JERK_ON.playerSeat);

    const bad = seating(JERK_ON).filter(
      (seat) => seat.occupant.kind === 'bot' && seat.occupant.policyId !== PERFECT_POLICY.id,
    );
    expect(bad).toHaveLength(1);
  });

  it('is the same seat in the seating chart and in the deciders', () => {
    // Both are derived from the config independently. If they disagree, the
    // screen names one seat and a different seat plays the habit — and the
    // counterfactual then corrects a seat that was already playing the book,
    // producing a tally of nothing but `unchanged` that looks like the lesson.
    for (let seed = 1; seed <= 40; seed += 1) {
      const config: TableConfig = { ...JERK_ON, seed };
      const jerk = jerkAt(config);
      if (jerk === null) continue;

      const chart = seating(config).findIndex(
        (seat) => seat.occupant.kind === 'bot' && seat.occupant.policyId !== PERFECT_POLICY.id,
      );
      expect(chart).toBe(jerk.seat);
      expect(botDeciders(config).has(jerk.seat)).toBe(true);
    }
  });

  it('does not move a single card by existing', () => {
    // M3 decision 23: `assignJerk` draws from a stream derived with its own
    // label, so the shuffle is untouched. The app could still break this by
    // folding the flag into the game seed, which is exactly the mistake that
    // would make every counterfactual a comparison of two different shoes
    // while still producing plausible numbers.
    for (let seed = 1; seed <= 20; seed += 1) {
      const on = openTableState({ ...JERK_ON, seed }, botDeciders({ ...JERK_ON, seed }));
      const off = openTableState({ ...JERK_OFF, seed }, botDeciders({ ...JERK_OFF, seed }));
      expect(on.session.state.shoe.cards).toEqual(off.session.state.shoe.cards);
      expect(on.session.state.shoeSeed).toBe(off.session.state.shoeSeed);
    }
  });
});

// --- 1 & 2. What the tally counts, and when --------------------------------

describe('the jerk tally', () => {
  it('stays empty with Jerk Mode off, because nothing was counted', () => {
    const state = play(JERK_OFF, 12);
    expect(state.jerkTally).toEqual(EMPTY_JERK_TALLY);
    expect(state.jerkCheck).toBeNull();
    expect(tally(state).jerk).toEqual(EMPTY_JERK_TALLY);
  });

  it('counts every round drawn, not the ones the player checked', () => {
    // The load-bearing assertion of the feature. `revealCheck` is never called
    // anywhere in this test, so a tally driven by the tap would read zero here
    // — and a tally driven by the *offer* would read only the losing rounds.
    const state = play(JERK_ON, 25);
    const counted = state.jerkTally.helped + state.jerkTally.hurt + state.jerkTally.unchanged;

    expect(counted).toBe(roundsDrawn(state.log));
    expect(counted).toBeGreaterThan(20);
    // Losses are a minority of rounds, so a tally of only the offered rounds
    // would be strictly smaller. This is the shape of the bug, pinned.
    expect(counted).toBeGreaterThan(tally(state).roundsPlayed / 2);
  });

  it('advances on the draw clock, not on the tap', () => {
    const config = JERK_ON;
    const deciders = botDeciders(config);
    let state = drain(openTableState(config, deciders));

    // Play until a submit finishes a round the felt has not caught up with.
    let submitted = state;
    for (let i = 0; i < 200; i += 1) {
      submitted = submit(state, config, deciders);
      if (submitted.unshownRounds.length > 0) break;
      state = drain(submitted);
    }
    expect(submitted.unshownRounds.length).toBeGreaterThan(0);

    // The engine has settled the round. The player has not seen it settle.
    expect(submitted.jerkTally).toEqual(state.jerkTally);

    const drawn = drain(submitted);
    expect(drawn.unshownRounds).toHaveLength(0);
    const before = state.jerkTally;
    const after = drawn.jerkTally;
    expect(after.helped + after.hurt + after.unchanged).toBe(
      before.helped + before.hurt + before.unchanged + 1,
    );
  });

  it('never strands a recording behind a newer round', () => {
    // The precondition `closeShownRound` documents. Rounds are drawn in order
    // and each completed round emits exactly one `RoundStarted` after it (M3
    // decision 21), so more than one waiting recording means round identity has
    // broken — which is invisible except as a tally that quietly stops moving.
    const config = JERK_ON;
    const deciders = botDeciders(config);
    let state = drain(openTableState(config, deciders));
    for (let i = 0; i < 400; i += 1) {
      if (state.felt.roundNumber > 20) break;
      const submitted = submit(state, config, deciders);
      expect(submitted.unshownRounds.length).toBeLessThanOrEqual(1);
      let partial = submitted;
      while (partial.pending.length > 0) {
        partial = drawNext(partial);
        expect(partial.unshownRounds.length).toBeLessThanOrEqual(1);
      }
      state = partial;
    }
    expect(state.unshownRounds).toHaveLength(0);
  });

  it('reaches the same count drawn all at once as one at a time', () => {
    // `drawAll` is the "skip animation" control. It must not be a second answer
    // to "when is a round over" — see `shown.test.ts` for the same property on
    // the felt and the log.
    const config = JERK_ON;
    const deciders = botDeciders(config);
    let slow = drain(openTableState(config, deciders));
    let fast = drawAll(openTableState(config, deciders));

    for (let i = 0; i < 200; i += 1) {
      if (slow.felt.roundNumber > 15) break;
      slow = drain(submit(slow, config, deciders));
      fast = drawAll(submit(fast, config, deciders));
    }

    expect(fast.jerkTally).toEqual(slow.jerkTally);
    expect(fast.log).toEqual(slow.log);
    expect(fast.felt).toEqual(slow.felt);
  });

  it('is the tally the report card reads', () => {
    const state = play(JERK_ON, 15);
    expect(tally(state).jerk).toBe(state.jerkTally);
  });
});

// --- Solvency --------------------------------------------------------------

describe('a bot that runs out of money', () => {
  it('sits the round out instead of taking the table down with it', () => {
    // `flatBettor` states an intent and `validateBet` throws when the seat
    // cannot cover it — and the throw kills the whole table, not the seat.
    // A book-playing bot loses ~0.4% a round and would survive for thousands;
    // `mimics-dealer` loses 6.3% (PLAN, M3) and is broke in about 300. Jerk
    // Mode is therefore what makes a pre-existing crash reachable, and this is
    // the assertion that stops it coming back.
    const config: TableConfig = {
      ...JERK_ON,
      seed: seedWhoseJerkIs('mimics-dealer'),
      // Two rounds of funding, so the seat is broke almost immediately and the
      // test does not depend on a 300-round grind to reach the interesting case.
      bankroll: 500,
      botBet: 250,
    };

    const state = play(config, 40);
    const jerkSeat = jerkAt(config)?.seat ?? -1;
    const broke = state.felt.seats[jerkSeat];

    expect(broke?.bankroll).toBeLessThan(config.botBet);
    // The table kept running, and the player kept playing.
    expect(state.felt.roundNumber).toBeGreaterThan(30);
    expect(tally(state).roundsPlayed).toBeGreaterThan(30);
  });

  it('never bets below the table minimum or above what it holds', () => {
    const config: TableConfig = {
      ...JERK_ON,
      seed: seedWhoseJerkIs('mimics-dealer'),
      bankroll: 500,
      botBet: 250,
    };
    const deciders = botDeciders(config);
    let state = drain(openTableState(config, deciders));

    for (let i = 0; i < 800; i += 1) {
      if (state.felt.roundNumber > 40) break;
      if (state.prompt.kind === 'bet') {
        for (const seat of state.felt.seats) {
          // A seat that bet at all bet something legal; `baseBet` of 0 is the
          // sit-out, which is the whole point of the guard.
          if (seat.baseBet > 0) expect(seat.baseBet).toBeGreaterThanOrEqual(VEGAS_STRIP.minBet);
        }
      }
      state = drain(submit(state, config, deciders));
    }
  });
});

// --- The offer -------------------------------------------------------------

describe('the §7 offer', () => {
  it('only appears on a round the player lost', () => {
    const config = JERK_ON;
    const deciders = botDeciders(config);
    let state = drain(openTableState(config, deciders));
    let offers = 0;

    for (let i = 0; i < 600; i += 1) {
      if (state.felt.roundNumber > 40) break;
      const next = drain(submit(state, config, deciders));
      if (next.jerkCheck !== null && next.jerkCheck !== state.jerkCheck) {
        offers += 1;
        // SPEC §7: the offer answers the feeling a player only has after losing.
        expect(next.jerkCheck.result.actual.net).toBeLessThan(0);
        expect(next.jerkCheck.result.observedSeat).toBe(config.playerSeat);
        expect(next.jerkCheck.result.correctedSeat).toBe(jerkAt(config)?.seat);
        expect(next.jerkCheck.revealed).toBe(false);
      }
      state = next;
    }
    expect(offers).toBeGreaterThan(3);
  });

  it('is never made about the habit that consumes no cards', () => {
    // `always-insures` is a side bet: its counterfactual is `unchanged` every
    // round by construction (replay.ts decision 30). Asking "did that cost
    // you?" about a play that provably cannot is a question with a known
    // answer, and the tally still counts those rounds honestly.
    const seed = seedWhoseJerkIs('always-insures');
    const config: TableConfig = { ...JERK_ON, seed };
    const state = play(config, 30);

    expect(jerkAt(config)?.policy.id).toBe('always-insures');
    expect(state.jerkCheck).toBeNull();
    expect(state.jerkTally.helped).toBe(0);
    expect(state.jerkTally.hurt).toBe(0);
    expect(state.jerkTally.unchanged).toBe(roundsDrawn(state.log));
    expect(state.jerkTally.netDelta).toBe(0);
  });

  it('reveals a number that already existed', () => {
    // `revealed` is about the screen and nothing else. The counterfactual is
    // computed for every round, so tapping must not change a single figure —
    // if it did, the tally and the card would be quoting two computations.
    const config = JERK_ON;
    const deciders = botDeciders(config);
    let state = drain(openTableState(config, deciders));
    for (let i = 0; i < 600 && state.jerkCheck === null; i += 1) {
      state = drain(submit(state, config, deciders));
    }
    expect(state.jerkCheck).not.toBeNull();

    const revealed = revealCheck(state);
    expect(revealed.jerkCheck?.revealed).toBe(true);
    expect(revealed.jerkCheck?.result).toBe(state.jerkCheck?.result);
    expect(revealed.jerkTally).toBe(state.jerkTally);
  });

  it('does not flip the sign of the verdict it renders', () => {
    // replay.ts decision 29 pins this in the engine; the app can still undo it
    // by pairing the wrong number with the wrong label. `delta` is
    // `corrected − actual`, so `hurt` must mean correct play paid more.
    const { offers } = LOUD_SESSION;
    expect(offers.length).toBeGreaterThan(50);

    for (const { verdict, delta, actual, corrected } of offers) {
      expect(delta).toBeCloseTo(corrected.net - actual.net, 10);
      if (verdict === 'hurt') expect(corrected.net).toBeGreaterThan(actual.net);
      if (verdict === 'helped') expect(corrected.net).toBeLessThan(actual.net);
      if (verdict === 'unchanged') expect(corrected.net).toBeCloseTo(actual.net, 10);
    }

    // Non-vacuous: without this the loop above may only ever have run on rounds
    // where `corrected.net === actual.net`, which cannot tell the labels apart.
    // Decision 68's failure — an assertion whose subject does not exist —
    // caught two vacuous tests in the hint layer and is the reason this is here.
    expect(offers.some((offer) => offer.verdict !== 'unchanged')).toBe(true);
  });

  it('is a biased sample of the rounds, which is why the tally is not built from it', () => {
    // **The measurement this whole design rests on.** Over 300 rounds against
    // `mimics-dealer`, the tally — folded from every completed round — reads
    // helped 10 / hurt 11, which is SPEC §7's lesson converging in front of the
    // player. The *offers* over the identical session read helped 0 / hurt 10,
    // because an offer requires a losing round and a round the jerk helped is
    // one you are more likely to have won.
    //
    // So a tally built from the taps, or even from the offers, would have
    // reported "hurt 10, helped 0" and taught the myth the feature exists to
    // refute — with every number on it arithmetically correct. That is not an
    // argument here, it is a measurement, and this test is what keeps it one.
    const { state, offers } = LOUD_SESSION;
    const { helped, hurt } = state.jerkTally;

    // Unbiased sample: roughly even, which is the claim SPEC §7 makes.
    expect(helped).toBeGreaterThan(0);
    expect(hurt).toBeGreaterThan(0);
    expect(Math.abs(helped - hurt)).toBeLessThanOrEqual((helped + hurt) / 2);

    // Offer-conditioned sample: heavily skewed the other way.
    const decisive = offers.filter((offer) => offer.verdict !== 'unchanged');
    const offeredHelped = decisive.filter((offer) => offer.verdict === 'helped').length;
    expect(decisive.length).toBeGreaterThan(5);
    expect(offeredHelped / decisive.length).toBeLessThan(0.25);
  });
});
