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
 * 3. **`TableState.jerk` is the only record of who plays badly.** The seating
 *    chart used to carry it too; two sources that must be kept in agreement is a
 *    weaker guarantee than one, and the chart was the one that could not be
 *    updated once the player could move the habit mid-session.
 * 4. **Choosing a bad player moves no cards** (M3 decision 23, extended per-seat
 *    by `habitFor`). That is the property that makes the comparison a comparison
 *    rather than two unrelated shoes, and it is the app's job not to break it by
 *    threading the choice into the wrong seed.
 * 5. **A round is attributed to whoever was playing badly *during it***, not to
 *    whoever is playing badly when it finishes being drawn. Those differ
 *    whenever the felt lags the engine, which is always.
 */

import {
  EMPTY_JERK_TALLY,
  openTable,
  PERFECT_POLICY,
  showEvents,
  VEGAS_STRIP,
  type Action,
  type Counterfactual,
  type GameEvent,
  type ShownSeat,
  type ShownTable,
} from '@bj/engine';
import { describe, expect, it } from 'vitest';

import {
  act,
  bet,
  botDeciders,
  DEFAULT_CONFIG,
  drawAll,
  drawNext,
  habitFor,
  insure,
  openingDeciders,
  openingJerk,
  openTableState,
  revealCheck,
  seating,
  setJerk,
  tally,
  untilSwept,
  type JerkCheck,
  type TableConfig,
  type TableState,
} from '../src/table/tableState';

/** $5, in cents (money.ts) — the table minimum. */
const BET = 500;

const JERK_ON: TableConfig = { ...DEFAULT_CONFIG, startWithJerk: true };
const JERK_OFF: TableConfig = { ...DEFAULT_CONFIG, startWithJerk: false };

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
function submit(state: TableState, config: TableConfig, deciders = openingDeciders(config)): TableState {
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
  const deciders = openingDeciders(config);
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
    if (openingJerk({ ...JERK_ON, seed })?.policy.id === policyId) return seed;
  }
  throw new Error(`no seed within 500 assigns "${policyId}"`);
}

/** Drive a session, keeping every offer the app made along the way. */
function playCollectingOffers(
  config: TableConfig,
  rounds: number,
): { readonly state: TableState; readonly offers: readonly Counterfactual[] } {
  const { state, checks } = playCollectingChecks(config, rounds);
  return { state, offers: checks.map((check) => check.result) };
}

/**
 * The same drive, keeping the whole `JerkCheck` rather than its `result`.
 *
 * The card draws two *hands* as well as two numbers (SPEC §7's "side by side"),
 * and the fields that carry them — `actualEvents` and `seats` — are not on
 * `Counterfactual`.
 */
function playCollectingChecks(
  config: TableConfig,
  rounds: number,
): { readonly state: TableState; readonly checks: readonly JerkCheck[] } {
  const deciders = openingDeciders(config);
  let state = drain(openTableState(config, deciders));
  const checks: JerkCheck[] = [];

  for (let i = 0; i < rounds * 40; i += 1) {
    if (state.felt.roundNumber > rounds) break;
    const next = drain(submit(state, config, deciders));
    if (next.jerkCheck !== null && next.jerkCheck !== state.jerkCheck) {
      checks.push(next.jerkCheck);
    }
    state = next;
  }
  return { state, checks };
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

// --- 3. One record of who plays badly ---------------------------------------

describe('who plays badly', () => {
  it('is nobody at all with Jerk Mode off', () => {
    expect(openingJerk(JERK_OFF)).toBeNull();
    for (const index of JERK_OFF.botSeats) {
      const occupant = seating(JERK_OFF)[index]?.occupant;
      expect(occupant?.kind === 'bot' ? occupant.policyId : null).toBe(PERFECT_POLICY.id);
    }
  });

  it('is exactly one bot seat, and never the player', () => {
    const jerk = openingJerk(JERK_ON);
    expect(jerk).not.toBeNull();
    expect(JERK_ON.botSeats).toContain(jerk?.seat);
    expect(jerk?.seat).not.toBe(JERK_ON.playerSeat);
  });

  /**
   * **The seating chart deliberately does not know.** It used to bake the habit
   * into `occupant.policyId`, which was correct while the assignment was fixed
   * at deal and became a lie once the player could move it: the chart is written
   * once at `createGame` and never rewritten. The old invariant here was "the
   * chart and the deciders agree"; keeping two sources in agreement is a weaker
   * guarantee than having one, and this is the assertion that stops the second
   * one growing back.
   */
  it('is not recorded in the seating chart at all', () => {
    for (const config of [JERK_ON, JERK_OFF]) {
      for (const seat of seating(config)) {
        if (seat.occupant.kind !== 'bot') continue;
        expect(seat.occupant.policyId).toBe(PERFECT_POLICY.id);
      }
    }
  });

  it('has a decider for every bot seat, and only for bot seats', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const config: TableConfig = { ...JERK_ON, seed };
      expect([...openingDeciders(config).keys()].sort((a, b) => a - b)).toEqual([
        ...config.botSeats,
      ]);
    }
  });

  it('does not move a single card by existing', () => {
    // M3 decision 23: `assignJerk` draws from a stream derived with its own
    // label, so the shuffle is untouched. The app could still break this by
    // folding the flag into the game seed, which is exactly the mistake that
    // would make every counterfactual a comparison of two different shoes
    // while still producing plausible numbers.
    for (let seed = 1; seed <= 20; seed += 1) {
      const on = openTableState({ ...JERK_ON, seed }, openingDeciders({ ...JERK_ON, seed }));
      const off = openTableState({ ...JERK_OFF, seed }, openingDeciders({ ...JERK_OFF, seed }));
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
    const deciders = openingDeciders(config);
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
    const deciders = openingDeciders(config);
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
    const deciders = openingDeciders(config);
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
      bankroll: 500_00,
      botBet: 250_00,
    };

    const state = play(config, 40);
    const jerkSeat = openingJerk(config)?.seat ?? -1;
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
      bankroll: 500_00,
      botBet: 250_00,
    };
    const deciders = openingDeciders(config);
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
    const deciders = openingDeciders(config);
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
        expect(next.jerkCheck.result.correctedSeat).toBe(openingJerk(config)?.seat);
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

    expect(openingJerk(config)?.policy.id).toBe('always-insures');
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
    const deciders = openingDeciders(config);
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


// --- 5. Moving the bad habit mid-session -----------------------------------

/**
 * The player may hand the habit to any bot seat, or take it away, at any moment
 * (SPEC §6). Four things must hold for that to be more than a cosmetic toggle,
 * and the last two fail silently.
 *
 * 1. **A seat plays the same habit however it was reached.** Otherwise a session
 *    stops being reproducible from its seed and the demo's subject changes
 *    identity while the player watches it.
 * 2. **It changes who actually plays badly**, not just a label.
 * 3. **It moves no card**, so a counterfactual stays a comparison rather than
 *    two unrelated shoes.
 * 4. **A round is attributed to whoever was playing badly during it.**
 *    `closeShownRound` runs on the draw clock, which lags the engine, so reading
 *    the *current* assignment would correct a seat that had been following the
 *    book — `delta` of zero, verdict `unchanged`, and a tally quietly
 *    accumulating false evidence for the myth the feature refutes.
 */
describe('moving the bad habit', () => {
  const SEATS = [2, 4] as const;

  /**
   * A seed at which *both* movable seats draw the loudest habit.
   *
   * Decision 68's trap, and this file's own warning: five of the six habits
   * barely fire, and a divergence test seeded onto a quiet one compares two
   * identical streams and passes while asserting nothing. `mimics-dealer`
   * deviates most rounds, so with it at both seats the only difference between
   * the two tables is *which* seat is bad — which is the thing being tested.
   */
  const LOUD_SEED = (() => {
    for (let seed = 1; seed < 4000; seed += 1) {
      if (SEATS.every((seat) => habitFor(seed, seat).id === 'mimics-dealer')) return seed;
    }
    throw new Error('no seed within 4000 gives both seats `mimics-dealer`');
  })();

  const MOVABLE: TableConfig = { ...JERK_ON, botSeats: [...SEATS], playerSeat: 3 };
  const LOUD: TableConfig = { ...MOVABLE, seed: LOUD_SEED, startWithJerk: false };

  function opened(config: TableConfig): TableState {
    return drain(openTableState(config, openingDeciders(config)));
  }

  /** Play until a submit finishes a round the felt has not caught up with. */
  function untilRoundQueued(state: TableState, config: TableConfig): TableState {
    let caughtUp = state;
    for (let i = 0; i < 200; i += 1) {
      const submitted = submit(caughtUp, config, botDeciders(config, caughtUp.jerk));
      if (submitted.unshownRounds.length > 0) return submitted;
      caughtUp = drain(submitted);
    }
    throw new Error('no round completed within 200 submits');
  }

  it('gives a seat the same habit however it is reached', () => {
    const start = opened(MOVABLE);
    for (const seat of SEATS) {
      // Directly, and by way of the other seat.
      const other = seat === 2 ? 4 : 2;
      const direct = setJerk(start, MOVABLE, seat);
      const roundabout = setJerk(setJerk(start, MOVABLE, other), MOVABLE, seat);
      expect(direct.jerk?.policy.id).toBe(habitFor(MOVABLE.seed, seat).id);
      expect(roundabout.jerk?.policy.id).toBe(direct.jerk?.policy.id);
    }
  });

  /**
   * The opening assignment is the one call site that could have been the
   * exception to that rule, because `assignJerk` returns a policy of its own.
   */
  it('opens with the habit that seat plays, not a second draw', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const jerk = openingJerk({ ...MOVABLE, seed });
      if (jerk === null) continue;
      expect(jerk.policy.id).toBe(habitFor(seed, jerk.seat).id);
    }
  });

  it('hands the habit to the named seat, and to nobody else', () => {
    const start = opened(MOVABLE);
    for (const seat of SEATS) {
      const moved = setJerk(start, MOVABLE, seat);
      expect(moved.jerk?.seat).toBe(seat);
      expect([...botDeciders(MOVABLE, moved.jerk).keys()].sort((a, b) => a - b)).toEqual([
        ...SEATS,
      ]);
    }
    expect(setJerk(start, MOVABLE, null).jerk).toBeNull();
  });

  /**
   * Re-selecting the seat that already holds the habit is not a change, so it
   * must not spoil the round in flight. Without this, tapping the highlighted
   * pill — the most natural thing to do to a selected control — would silently
   * drop a round from the §7 tally.
   */
  it('is a no-op when the habit is already where it is being sent', () => {
    const start = midRound(MOVABLE);
    const seat = start.jerk?.seat ?? null;
    expect(seat).not.toBeNull();
    expect(setJerk(start, MOVABLE, seat)).toBe(start);
    expect(setJerk(start, MOVABLE, seat).jerkStraddled).toBe(false);

    // And likewise for "nobody", once nobody is who holds it.
    const cleared = setJerk(start, MOVABLE, null);
    expect(setJerk(cleared, MOVABLE, null)).toBe(cleared);
  });

  it('refuses a seat that holds no bot — that is a caller bug', () => {
    const start = opened(MOVABLE);
    expect(() => setJerk(start, MOVABLE, MOVABLE.playerSeat)).toThrow();
    expect(() => setJerk(start, MOVABLE, 0)).toThrow();
  });

  it('moves no card', () => {
    const start = opened(MOVABLE);
    for (const seat of [...SEATS, null]) {
      const moved = setJerk(start, MOVABLE, seat);
      expect(moved.session.state.shoe.cards).toEqual(start.session.state.shoe.cards);
      expect(moved.session.state.shoeSeed).toBe(start.session.state.shoeSeed);
      expect(moved.felt).toBe(start.felt);
      expect(moved.log).toBe(start.log);
    }
  });

  it('actually changes how the table plays', () => {
    // Behavioural, not structural: same seed, same taps, a different bad seat,
    // and the streams must diverge. A `setJerk` that updated a label and left
    // the deciders alone would pass every assertion above this one.
    function streamWith(seat: number | null): readonly GameEvent[] {
      let state = setJerk(opened(LOUD), LOUD, seat);
      for (let i = 0; i < 200; i += 1) {
        if (state.felt.roundNumber > 4) break;
        state = drain(submit(state, LOUD, botDeciders(LOUD, state.jerk)));
      }
      return state.log;
    }
    const atTwo = streamWith(2);
    expect(atTwo).not.toEqual(streamWith(4));
    expect(atTwo).not.toEqual(streamWith(null));
  });

  it('attributes a round played wholly under one assignment to that assignment', () => {
    // A change at a bet prompt costs nothing: no cards are out, so nothing can
    // have been straddled and the round that follows is attributed normally.
    const start = opened(MOVABLE);
    expect(start.prompt.kind).toBe('bet');

    const moved = setJerk(start, MOVABLE, 4);
    expect(moved.jerkStraddled).toBe(false);

    const queued = untilRoundQueued(moved, MOVABLE);
    expect(queued.unshownRounds[0]?.jerk?.seat).toBe(4);
  });

  /**
   * The load-bearing one. Mid-round, the bots before the player acted under one
   * assignment and those after it under another, so no single `correctedSeat`
   * yields an honest comparison.
   */
  it('drops a round that straddled a change, rather than misattributing it', () => {
    const start = midRound(MOVABLE);
    const moved = setJerk(start, MOVABLE, start.jerk?.seat === 2 ? 4 : 2);
    expect(moved.jerkStraddled).toBe(true);

    const queued = untilRoundQueued(moved, MOVABLE);
    // Stamped `null`: no honest comparison exists for this one.
    expect(queued.unshownRounds[0]?.jerk).toBeNull();
    // And spent, so the *next* round is attributed normally again.
    expect(queued.jerkStraddled).toBe(false);
  });

  /**
   * The flag must survive the decisions between the change and the end of the
   * round. Clearing it on the next tap — an advance that completes no round and
   * so has nothing to mark — would let it expire unused and the straddled round
   * be stamped with the current assignment after all.
   */
  it('keeps the round marked across the taps that finish it', () => {
    // The *other* seat: re-selecting the seat already holding the habit changes
    // nothing, so `setJerk` returns the state untouched and spoils no round.
    const start = midRound(MOVABLE);
    let state = setJerk(start, MOVABLE, start.jerk?.seat === 2 ? 4 : 2);
    expect(state.jerkStraddled).toBe(true);

    for (let i = 0; i < 200; i += 1) {
      const submitted = submit(state, MOVABLE, botDeciders(MOVABLE, state.jerk));
      if (submitted.unshownRounds.length > 0) {
        expect(submitted.unshownRounds[0]?.jerk).toBeNull();
        return;
      }
      // Still in the same round, so the mark must still be there.
      expect(submitted.jerkStraddled).toBe(true);
      state = drain(submitted);
    }
    throw new Error('no round completed within 200 submits');
  });

  it('adds nothing to the tally for a straddled round, and does not strand it', () => {
    const start = midRound(MOVABLE);
    const moved = setJerk(start, MOVABLE, start.jerk?.seat === 2 ? 4 : 2);
    const queued = untilRoundQueued(moved, MOVABLE);

    const before = counted(queued.jerkTally);
    const drawn = drain(queued);
    expect(counted(drawn.jerkTally)).toBe(before);
    // Spent, not stranded: a queue that kept it would let a later round match
    // the wrong recording forever after.
    expect(drawn.unshownRounds).toHaveLength(0);
  });

  /** A state with cards out and the player on the clock. */
  function midRound(config: TableConfig): TableState {
    let state = drain(openTableState(config, openingDeciders(config)));
    for (let i = 0; i < 60; i += 1) {
      if (state.prompt.kind === 'action') return state;
      state = drain(submit(state, config, botDeciders(config, state.jerk)));
    }
    throw new Error('no action prompt within 60 submits');
  }

  function counted(t: TableState['jerkTally']): number {
    return t.helped + t.hurt + t.unchanged;
  }
});

// --- The two hands, side by side -------------------------------------------

describe('the §7 comparison shows the hands the numbers came from', () => {
  /**
   * SPEC §7 asks for the two outcomes "side by side", and the myth is a claim
   * about *cards* — so the card draws both hands, folded out of the two event
   * streams by `shown.ts`. That fold is the engine's, proved field-for-field
   * against `session.state` in `shown.test.ts`, and none of it is re-tested
   * here.
   *
   * What the *app* decides is which stream goes in which column, and that is a
   * mistake with no symptom: swap them and the felt renders two entirely
   * plausible hands beside two correct numbers, with the labels reversed. The
   * lesson would then be taught backwards using true figures.
   */
  const CHECKS = playCollectingChecks(JERK_ON, 40).checks;

  it('offers something to compare', () => {
    expect(CHECKS.length).toBeGreaterThan(3);
  });

  it('stops the fold before the table is swept', () => {
    // The trap this card fell into, pinned so it cannot be walked back into.
    // `shown.ts` clears the felt on the way out of `cleanup`, so a *complete*
    // round folds to bare chairs and a dealer holding nothing — no throw, no
    // missing field, just two empty tables beside two correct numbers. Both
    // halves are asserted: that the whole stream really is empty, and that the
    // prefix really is not.
    for (const check of CHECKS) {
      for (const events of [check.actualEvents, check.result.events]) {
        expect(showEvents(openTable(check.seats), events).dealer.cards).toHaveLength(0);
        expect(feltOf(check.seats, events).dealer.cards.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns a stream that has not been swept yet whole', () => {
    // A round still being drawn has no sweep in it, and truncating it to
    // nothing would blank the felt mid-hand if this were ever reused there.
    const midRound = CHECKS[0]?.actualEvents.slice(0, 4) ?? [];
    expect(midRound.length).toBeGreaterThan(0);
    expect(untilSwept(midRound)).toBe(midRound);
  });

  it('never hands the same stream to both columns', () => {
    // The cheapest form of the swap: one array wired in twice. Every number on
    // screen would still be right, and the two hands would be identical.
    for (const check of CHECKS) {
      expect(check.actualEvents).not.toBe(check.result.events);
    }
  });

  it('draws a hand that adds up to the number beside it', () => {
    // The binding assertion. `SeatResult.net` counts insurance too, and the
    // hands on the felt do not carry it, so it is subtracted by name rather
    // than folded in — an insurance bet quietly landing in a hand's total is
    // exactly the kind of arithmetic this card must not invent.
    for (const check of CHECKS) {
      const seat = check.result.observedSeat;
      const actual = playerSeat(check.seats, check.actualEvents, seat);
      const corrected = playerSeat(check.seats, check.result.events, seat);

      expect(handsNet(actual)).toBe(check.result.actual.net - check.result.actual.insuranceNet);
      expect(handsNet(corrected)).toBe(
        check.result.corrected.net - check.result.corrected.insuranceNet,
      );
      expect(actual.hands).toHaveLength(check.result.actual.hands.length);
      expect(corrected.hands).toHaveLength(check.result.corrected.hands.length);
    }
  });

  it('shows the dealer face up in both worlds', () => {
    // The round is over in both. A face-down card in a settled comparison is
    // the felt withholding the one card the comparison is about — and
    // `showEvents` would happily produce it if the streams were truncated.
    for (const check of CHECKS) {
      for (const events of [check.actualEvents, check.result.events]) {
        const felt = feltOf(check.seats, events);
        expect(felt.dealer.cards.length).toBeGreaterThanOrEqual(2);
        expect(felt.dealer.cards.every((card) => card.facing === 'up')).toBe(true);
      }
    }
  });

  it('draws two different hands at least sometimes', () => {
    // Without this the three tests above all pass when `actualEvents` is wired
    // into both columns — the player would be shown one hand twice and told it
    // was a comparison. A card-consuming habit shifts the shoe (replay.ts's
    // whole premise), so over 40 rounds the two worlds must differ somewhere.
    const differing = CHECKS.filter((check) => {
      const seat = check.result.observedSeat;
      const actual = playerSeat(check.seats, check.actualEvents, seat);
      const corrected = playerSeat(check.seats, check.result.events, seat);
      return cardsOf(actual) !== cardsOf(corrected);
    });
    expect(differing.length).toBeGreaterThan(0);
  });

  it('seats the comparison the way the round was seated', () => {
    // `seats` comes off the recording's start state, not off `state.felt` —
    // which has moved on, and whose bankrolls are current. A chart of the wrong
    // length folds every seat index by one and the player's hands appear in
    // somebody else's column.
    for (const check of CHECKS) {
      expect(check.seats).toHaveLength(VEGAS_STRIP.seatCount);
      expect(check.seats.map((seat) => seat.index)).toEqual(
        check.seats.map((_, index) => index),
      );
    }
  });

  function playerSeat(
    seats: JerkCheck['seats'],
    events: readonly GameEvent[],
    index: number,
  ): ShownSeat {
    const seat = feltOf(seats, events).seats[index];
    if (seat === undefined) throw new Error(`no seat ${index} on the folded felt`);
    return seat;
  }

  /** Exactly what `Showdown` does, so the tests cannot fold differently. */
  function feltOf(seats: JerkCheck['seats'], events: readonly GameEvent[]): ShownTable {
    return showEvents(openTable(seats), untilSwept(events));
  }

  function handsNet(seat: ShownSeat): number {
    return seat.hands.reduce((sum, hand) => sum + (hand.net ?? 0), 0);
  }

  function cardsOf(seat: ShownSeat): string {
    return seat.hands.map((hand) => hand.cards.map((card) => card.rank).join('')).join('|');
  }
});
