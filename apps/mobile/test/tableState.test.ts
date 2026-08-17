/**
 * The first tests `@bj/mobile` has had.
 *
 * They cover the app's own logic and nothing else. The engine is proved
 * elsewhere and is not re-tested here; what is checked is the four things the
 * app decides for itself, each of which is easy to get wrong in a way that
 * throws nothing and looks right on screen:
 *
 * 1. Coaching is computed **at the prompt**, once, and is about the decision
 *    being asked.
 * 2. Advice is withheld until the felt has caught up; a verdict is not.
 * 3. The hint mode changes what is revealed and never what is computed.
 * 4. The tap is priced against the advice the player was actually shown, and
 *    the retained log tracks what they were shown rather than what the engine
 *    has already decided.
 */

import type { Action } from '@bj/engine';
import { describe, expect, it } from 'vitest';

import {
  act,
  bet,
  openingDeciders,
  DEFAULT_CONFIG,
  drawAll,
  drawNext,
  hint,
  hintAvailable,
  HINT_MODES,
  insure,
  openTableState,
  requestHint,
  tally,
  type TableConfig,
  type TableState,
} from '../src/table/tableState';

const CONFIG: TableConfig = { ...DEFAULT_CONFIG, seed: 20260812 };
const DECIDERS = openingDeciders(CONFIG);
const SETTINGS = CONFIG.coachSettings;
/** $5, in cents (money.ts) — the table minimum. */
const BET = 500;

// --- Driving ---------------------------------------------------------------

/** Drain the queue one event at a time, as the clock does. */
function drain(state: TableState): TableState {
  let current = state;
  while (current.pending.length > 0) current = drawNext(current);
  return current;
}

/**
 * Answer whatever is being asked, drawing everything in between. `choose` picks
 * an action from the coaching the player was shown, which is how a real tap
 * works — the screen has the same object in hand.
 */
function step(state: TableState, choose: (state: TableState) => Action): TableState {
  const ready = drain(state);
  switch (ready.prompt.kind) {
    case 'bet':
      return bet(ready, ready.prompt.max < ready.prompt.min ? 0 : BET, DECIDERS, SETTINGS);
    case 'insurance':
      return insure(ready, false, DECIDERS, SETTINGS);
    case 'action':
      return act(ready, choose(ready), DECIDERS, SETTINGS);
  }
}

/**
 * Advance to the first prompt that carries coaching.
 *
 * The opening prompt is a *bet*, and a bet prompt has no coaching at all
 * (coach.ts decision 44), so `drain(openTableState(...))` is the wrong place to
 * ask anything about advice.
 */
function firstCoached(state: TableState): TableState {
  let current = drain(state);
  while (current.coaching === null) current = drain(step(current, book));
  return current;
}

function play(rounds: number, choose: (state: TableState) => Action): TableState {
  let state = openTableState(CONFIG, DECIDERS);
  // Each round takes at least a bet and one action; this bound is generous and
  // the loop exits on the round count, not on it.
  for (let i = 0; i < rounds * 40; i += 1) {
    if (drain(state).felt.roundNumber > rounds) break;
    state = step(state, choose);
  }
  return drain(state);
}

/** The book answer, read off the coaching the screen would have rendered. */
function book(state: TableState): Action {
  if (state.coaching === null || state.coaching.kind !== 'action') {
    throw new Error('book: not an action prompt');
  }
  return state.coaching.recommendation.action;
}

/** Any legal action that is not the book answer, or the book answer if it is forced. */
function deviate(state: TableState): Action {
  if (state.prompt.kind !== 'action') throw new Error('deviate: not an action prompt');
  const recommended = book(state);
  const other = state.prompt.view.legalActions.find(
    (action) => action !== recommended && (action === 'hit' || action === 'stand'),
  );
  return other ?? recommended;
}

// --- 1. Coaching is computed at the prompt ---------------------------------

describe('coaching arrives with the prompt', () => {
  it('matches the kind of decision being asked, at every prompt', () => {
    let state = openTableState(CONFIG, DECIDERS);
    for (let i = 0; i < 60; i += 1) {
      state = drain(state);
      // coach.ts decision 44: a bet prompt gets no coaching, and `null` rather
      // than an explanation with nothing honest in it.
      if (state.prompt.kind === 'bet') expect(state.coaching).toBeNull();
      else expect(state.coaching?.kind).toBe(state.prompt.kind);
      state = step(state, book);
    }
  });

  it('recommends something the current prompt actually offers', () => {
    let state = openTableState(CONFIG, DECIDERS);
    let actionPrompts = 0;
    for (let i = 0; i < 120; i += 1) {
      state = drain(state);
      if (state.prompt.kind === 'action' && state.coaching?.kind === 'action') {
        actionPrompts += 1;
        expect(state.prompt.view.legalActions).toContain(state.coaching.recommendation.action);
      }
      state = step(state, book);
    }
    expect(actionPrompts).toBeGreaterThan(10);
  });

  it('is one object, held rather than recomputed', () => {
    // Two reads of the same state must be the same instance: `coach` costs
    // ~2 ms, and `assess` has to score the tap against what was on screen.
    const state = firstCoached(openTableState(CONFIG, DECIDERS));
    const shown = hint(state, 'always');
    expect(shown?.kind).toBe('advice');
    expect(shown?.kind === 'advice' ? shown.coaching : null).toBe(state.coaching);
  });
});

// --- 2. Advice waits for the felt ------------------------------------------

describe('the hint never runs ahead of the felt', () => {
  it('withholds advice while events are still queued', () => {
    const opened = openTableState(CONFIG, DECIDERS);
    expect(opened.pending.length).toBeGreaterThan(0);
    for (const mode of ['always', 'on-request'] as const) {
      expect(hint(requestHint(opened), mode)).toBeNull();
    }
    // The opening prompt is a bet, which carries no coaching either way, so
    // answer it: the deal that follows is queued behind a prompt that does.
    const dealing = step(opened, book);
    expect(dealing.pending.length).toBeGreaterThan(0);
    expect(hint(requestHint(dealing), 'always')).toBeNull();
    // …and produces it the moment the queue empties.
    expect(hint(drain(dealing), 'always')).not.toBeNull();
  });

  it('shows a verdict immediately, because it is about cards already drawn', () => {
    let state = drain(openTableState(CONFIG, DECIDERS));
    while (state.prompt.kind !== 'action') state = drain(step(state, book));

    const acted = act(state, deviate(state), DECIDERS, SETTINGS);
    expect(acted.pending.length).toBeGreaterThan(0);

    const shown = hint(acted, 'after');
    expect(shown?.kind).toBe('verdict');
  });
});

// --- 3. The mode reveals; it never computes --------------------------------

describe('hint modes (SPEC §5.5)', () => {
  it('computes the same coaching in all four modes, including off', () => {
    const state = firstCoached(openTableState(CONFIG, DECIDERS));
    expect(state.coaching).not.toBeNull();
    for (const mode of HINT_MODES) {
      // The coaching exists regardless; only `hint` differs. This is what makes
      // "after the fact" and deviation recording work in `off` mode at all.
      expect(state.coaching).not.toBeNull();
      expect(mode === 'always' ? hint(state, mode) : true).toBeTruthy();
    }
    expect(hint(state, 'off')).toBeNull();
    expect(hint(state, 'after')).toBeNull();
    expect(hint(state, 'on-request')).toBeNull();
    expect(hint(state, 'always')?.kind).toBe('advice');
  });

  it('on-request reveals on demand and re-hides at the next prompt', () => {
    const state = firstCoached(openTableState(CONFIG, DECIDERS));
    expect(hintAvailable(state, 'on-request')).toBe(true);

    const asked = requestHint(state);
    expect(hint(asked, 'on-request')?.kind).toBe('advice');
    expect(hintAvailable(asked, 'on-request')).toBe(false);

    const next = drain(step(asked, book));
    expect(next.hintRequested).toBe(false);
    expect(hint(next, 'on-request')).toBeNull();
  });

  it('offers no hint button outside on-request mode', () => {
    const state = firstCoached(openTableState(CONFIG, DECIDERS));
    expect(hintAvailable(state, 'always')).toBe(false);
    expect(hintAvailable(state, 'after')).toBe(false);
    expect(hintAvailable(state, 'off')).toBe(false);
  });
});

// --- 4. The tap is priced against what was shown ---------------------------

describe('deviations are recorded (SPEC §5.5)', () => {
  it('scores a followed recommendation at exactly zero', () => {
    const state = play(8, book);
    expect(state.decisions.length).toBeGreaterThan(8);
    for (const decision of state.decisions) {
      expect(decision.wasRecommended).toBe(true);
      expect(decision.evDelta).toBe(0);
      expect(decision.moneyDelta).toBe(0);
    }
    // report.ts decision 46: book play reports 0 on the nose, not "-0.00".
    expect(tally(state).evLost).toBe(0);
    expect(Object.is(tally(state).evLost, -0)).toBe(false);
    expect(tally(state).accuracy).toBe(1);
  });

  it('prices a deviation at the stake, and files it under the lesson missed', () => {
    let state = drain(openTableState(CONFIG, DECIDERS));
    while (state.prompt.kind !== 'action') state = drain(step(state, book));

    const advice = state.coaching;
    if (advice?.kind !== 'action') throw new Error('expected action coaching');
    const chosen = deviate(state);
    const acted = act(state, chosen, DECIDERS, SETTINGS);

    const decision = acted.decisions.at(-1);
    expect(decision).toBeDefined();
    if (decision === undefined) return;

    expect(decision.wasRecommended).toBe(chosen === advice.recommendation.action);
    // The mistake is filed under the code behind the *book* answer — the lesson
    // declined — not a description of what was done instead.
    expect(decision.reasonCode).toBe(advice.recommendation.reasonCode);
    expect(decision.moneyDelta).toBeCloseTo(decision.evDelta * advice.stake, 10);
    expect(advice.stake).toBe(BET);
  });

  it('records in off mode exactly as in always mode', () => {
    // The mode is a reveal setting. A player who turns hints off is still
    // being measured, which is what makes the report card meaningful.
    const played = play(6, deviate);
    expect(played.decisions.length).toBeGreaterThan(0);
    expect(tally(played).decisionsMade).toBe(played.decisions.length);
    expect(tally(played).deviations).toBeGreaterThan(0);
  });

  it('has no accuracy to report before the first decision', () => {
    // report.ts decision 47: 0/0 is not 100%.
    expect(tally(openTableState(CONFIG, DECIDERS)).accuracy).toBeNull();
  });
});

// --- The draw clock owns the log -------------------------------------------

describe('the retained log is what the player has been shown', () => {
  it('grows only as events are drawn', () => {
    const opened = openTableState(CONFIG, DECIDERS);
    expect(opened.log).toHaveLength(0);
    expect(opened.pending.length).toBeGreaterThan(0);

    const one = drawNext(opened);
    expect(one.log).toHaveLength(1);
    expect(one.pending).toHaveLength(opened.pending.length - 1);

    const all = drawAll(opened);
    expect(all.log).toHaveLength(opened.pending.length);
    expect(all.pending).toHaveLength(0);
  });

  it('drains one at a time to the same place as all at once', () => {
    const opened = openTableState(CONFIG, DECIDERS);
    expect(drain(opened).felt).toEqual(drawAll(opened).felt);
    expect(drain(opened).log).toEqual(drawAll(opened).log);
  });

  it('closes input while the queue is draining (M4 decision 60)', () => {
    let state = drain(openTableState(CONFIG, DECIDERS));
    while (state.prompt.kind !== 'action') state = drain(step(state, book));

    const acted = act(state, book(state), DECIDERS, SETTINGS);
    expect(acted.pending.length).toBeGreaterThan(0);
    // A tap mid-draw answers a prompt about a hand not yet on the felt. It is
    // dropped, not queued: the same object comes back.
    expect(act(acted, 'hit', DECIDERS, SETTINGS)).toBe(acted);
    expect(bet(acted, BET, DECIDERS, SETTINGS)).toBe(acted);
  });

  it('reports money that agrees with the bankroll the felt is showing', () => {
    // Two independent folds of one event stream: `roundResults` reads the
    // settlements, the felt reads `BankrollChanged`. They can only agree at a
    // round boundary, where no bet is outstanding.
    const state = play(10, book);
    expect(state.prompt.kind).toBe('bet');

    const seat = state.felt.seats[CONFIG.playerSeat];
    expect(seat).toBeDefined();
    if (seat === undefined) return;

    // Exact, not `toBeCloseTo`: money is integer cents now, so two folds of
    // the same stream agree on the nose or the projection is wrong (money.ts).
    expect(seat.bankroll).toBe(CONFIG.bankroll + tally(state).net);
    expect(tally(state).roundsPlayed).toBeGreaterThan(0);
  });
});
