/**
 * The table screen's state, as pure functions.
 *
 * This is everything `useTable` used to hold inline, lifted out of the hook for
 * one reason: it can now be driven in Node. `@bj/mobile` had no tests at all —
 * a green `npm test` proved the engine worked and that the app *typechecked* —
 * and the logic worth covering (coach once per prompt, reveal by hint mode,
 * price the tap, keep the log) is a pure function of `(state, input)`. None of
 * it needs a renderer. What is left in the hook is `useState`, `useEffect` and
 * `useCallback`, which is what a hook should be.
 *
 * There is still no game math here, which is the test M4 decision 58 sets for
 * whether something belongs in the app at all. This module calls `showEvents`,
 * `coach`, `assess` and `sessionReport`; it computes no total, no legal action,
 * no payout and no EV of its own.
 */

import {
  advanceUntilPlayer,
  assess,
  coach,
  createGame,
  createSession,
  EMPTY_JERK_TALLY,
  flatBettor,
  openTable,
  PERFECT_POLICY,
  PURE_PLAY,
  roundResults,
  sessionReport,
  showEvents,
  submitAction,
  submitBet,
  submitInsurance,
  VEGAS_STRIP,
  type Choice,
  type Coaching,
  type CoachSettings,
  type Deciders,
  type Decision,
  type GameEvent,
  type PlayerPrompt,
  type SeatConfig,
  type Session,
  type SessionReport,
  type SessionStep,
  type ShownTable,
} from '@bj/engine';

/**
 * When the hint is revealed (SPEC §5.5). Deliberately *not* part of
 * `CoachSettings`.
 *
 * The two settings look alike and are not. `CoachSettings.knownCards` changes
 * what the coach is allowed to know, so changing it changes every number —
 * it is the difference between reading the table and counting cards (SPEC
 * §5.3). A hint mode changes nothing but whether the card is on screen. Keeping
 * them apart is what lets `hint()` be a pure read of state that already exists:
 * switching modes never recomputes a thing, and the cost of coaching is
 * identical in all four modes, including `off`.
 */
export type HintMode = 'always' | 'on-request' | 'after' | 'off';

export const HINT_MODES: readonly HintMode[] = ['always', 'on-request', 'after', 'off'];

/** A decision the player has made, beside the advice they were given for it. */
export type Reviewed = {
  readonly coaching: Coaching;
  readonly decision: Decision;
};

/**
 * What the hint layer should draw right now.
 *
 * `advice` is forward-looking — the book answer for a decision not yet taken.
 * `verdict` is backward-looking — what the tap just made actually cost. They
 * are different shapes because they are different sentences, and a screen that
 * had to infer which one it was holding would eventually infer wrong.
 */
export type Hint =
  | { readonly kind: 'advice'; readonly coaching: Coaching }
  | { readonly kind: 'verdict'; readonly reviewed: Reviewed };

export type TableState = {
  readonly session: Session;
  /** What is drawn. Never `session.state` — see M4 decision 34. */
  readonly felt: ShownTable;
  /** Emitted by the engine, not yet drawn. */
  readonly pending: readonly GameEvent[];
  readonly prompt: PlayerPrompt;
  /**
   * Coaching for `prompt`, computed once when that prompt arrived, and `null`
   * on a bet prompt (coach.ts decision 44). Held rather than derived because
   * `coach` costs ~2 ms and a screen that called it in render would pay that
   * every frame — and because `assess` must score the tap against the advice
   * the player was actually shown, not against a fresh computation.
   */
  readonly coaching: Coaching | null;
  /** `on-request` only: has this prompt's hint been asked for? Resets with the prompt. */
  readonly hintRequested: boolean;
  /** `after` only: the last decision taken, and the advice it answered. */
  readonly reviewed: Reviewed | null;
  /**
   * Every event the player has been *shown*, append-only. This is the report
   * card's input, and it advances on the draw clock rather than the engine's —
   * see `drawn()`.
   */
  readonly log: readonly GameEvent[];
  /** Every decision priced against the book, in the order they were made. */
  readonly decisions: readonly Decision[];
};

export type TableConfig = {
  readonly seed: number;
  readonly playerSeat: number;
  readonly botSeats: readonly number[];
  readonly bankroll: number;
  readonly botBet: number;
  readonly coachSettings: CoachSettings;
};

export const DEFAULT_CONFIG: TableConfig = {
  seed: 20260812,
  /** Bottom-centre in the eventual 2.5D arc (SPEC §9). */
  playerSeat: 3,
  botSeats: [2, 4],
  bankroll: 500,
  botBet: 25,
  coachSettings: PURE_PLAY,
};

// --- Sitting down ----------------------------------------------------------

export function openTableState(config: TableConfig, deciders: Deciders): TableState {
  const game = createGame({ rules: VEGAS_STRIP, seed: config.seed, seats: seating(config) });
  const step = advanceUntilPlayer(createSession(game), deciders);
  return {
    ...arriveAt(step, config.coachSettings),
    felt: openTable(game.seats),
    reviewed: null,
    log: [],
    decisions: [],
  };
}

export function seating(config: TableConfig): readonly SeatConfig[] {
  return Array.from({ length: VEGAS_STRIP.seatCount }, (_, index): SeatConfig => {
    if (index === config.playerSeat) {
      return { occupant: { kind: 'player' }, bankroll: config.bankroll };
    }
    if (config.botSeats.includes(index)) {
      return {
        occupant: { kind: 'bot', policyId: PERFECT_POLICY.id, characterId: `seat-${index}` },
        bankroll: config.bankroll,
      };
    }
    return { occupant: { kind: 'empty' }, bankroll: 0 };
  });
}

export function botDeciders(config: TableConfig): Deciders {
  return new Map(
    config.botSeats.map((seat) => [seat, flatBettor(PERFECT_POLICY, config.botBet)]),
  );
}

// --- The draw clock --------------------------------------------------------

/**
 * Draw one queued event onto the felt.
 *
 * The event is appended to `log` at the same instant it is drawn, not when the
 * engine emitted it. One `submitAction` can settle a round and deal into the
 * next (M4 decision 34), so a log filled at emission time would let the running
 * tally report money the player has not yet seen change hands — the felt would
 * still show a live hand while the header said it had been paid. One clock for
 * everything the player can see.
 */
export function drawNext(state: TableState): TableState {
  const [next, ...rest] = state.pending;
  if (next === undefined) return state;
  return {
    ...state,
    felt: showEvents(state.felt, [next]),
    pending: rest,
    log: [...state.log, next],
  };
}

/** Draw everything still queued — the "skip animation" control. */
export function drawAll(state: TableState): TableState {
  if (state.pending.length === 0) return state;
  return {
    ...state,
    felt: showEvents(state.felt, state.pending),
    pending: [],
    log: [...state.log, ...state.pending],
  };
}

// --- Answering a prompt ----------------------------------------------------

/**
 * Advance the engine, and price what the player just chose.
 *
 * Precondition: `state.pending` is empty. A tap during the draw is dropped
 * rather than rejected — M4 decision 60 as code. Accepting it would mean
 * answering a prompt about a hand the player has not been shown.
 *
 * Precondition: `choice` describes `state.coaching`. `assess` throws on a
 * mismatch, which is the right response — an action scored against an insurance
 * offer is a caller bug, not a deviation.
 *
 * Postcondition: `reviewed` describes exactly the choice just passed, and
 * `coaching` describes the *new* prompt. Those are two different hands whenever
 * a tap resolves one and moves to the next, and conflating them is the mistake
 * PLAN warns about under "no hint-mode gating": coaching computed after the tap
 * is advice about the wrong decision, and throws outright on a hand that busted.
 */
export function answer(
  state: TableState,
  advance: (session: Session) => SessionStep,
  choice: Choice | null,
  settings: CoachSettings,
): TableState {
  if (state.pending.length > 0) return state;

  const scored =
    choice !== null && state.coaching !== null
      ? { coaching: state.coaching, decision: assess(state.coaching, choice) }
      : null;

  return {
    ...state,
    ...arriveAt(advance(state.session), settings),
    // A bet prompt clears the review: the verdict belongs to the hand it was
    // made on, and that hand is over.
    reviewed: scored,
    decisions: scored === null ? state.decisions : [...state.decisions, scored.decision],
  };
}

export function bet(state: TableState, amount: number, deciders: Deciders, settings: CoachSettings) {
  return answer(state, (session) => submitBet(session, amount, deciders), null, settings);
}

export function act(
  state: TableState,
  action: Parameters<typeof submitAction>[1],
  deciders: Deciders,
  settings: CoachSettings,
): TableState {
  return answer(
    state,
    (session) => submitAction(session, action, deciders),
    { kind: 'action', action },
    settings,
  );
}

export function insure(
  state: TableState,
  take: boolean,
  deciders: Deciders,
  settings: CoachSettings,
): TableState {
  return answer(
    state,
    (session) => submitInsurance(session, take, deciders),
    { kind: 'insurance', take },
    settings,
  );
}

/** The part of the state a new prompt replaces. Coaching happens here and nowhere else. */
function arriveAt(
  step: SessionStep,
  settings: CoachSettings,
): Pick<TableState, 'session' | 'pending' | 'prompt' | 'coaching' | 'hintRequested'> {
  return {
    session: step.session,
    pending: step.events,
    prompt: step.prompt,
    coaching: coach(step, settings),
    hintRequested: false,
  };
}

// --- The hint layer --------------------------------------------------------

/** `on-request` (SPEC §5.5): reveal this prompt's hint. Resets when the prompt changes. */
export function requestHint(state: TableState): TableState {
  return state.hintRequested ? state : { ...state, hintRequested: true };
}

/**
 * What to draw, given the mode. A pure read — nothing is computed here, which
 * is the whole reason `HintMode` is separate from `CoachSettings`.
 *
 * **Advice waits for the felt; a verdict does not.** This is M4 decision 34's
 * censorship applied to the hint card. The engine runs arbitrarily far ahead of
 * the draw, so `coaching` may already describe a hand whose cards are still in
 * the queue — rendering it would tell the player their total before dealing
 * them the card that makes it. A verdict is about a decision already taken on
 * cards already on the felt, so it is safe the instant the tap lands, which is
 * exactly what "play first, then see whether you were right" requires.
 */
export function hint(state: TableState, mode: HintMode): Hint | null {
  if (mode === 'off') return null;

  if (mode === 'after') {
    return state.reviewed === null ? null : { kind: 'verdict', reviewed: state.reviewed };
  }

  if (state.pending.length > 0) return null;
  if (mode === 'on-request' && !state.hintRequested) return null;
  return state.coaching === null ? null : { kind: 'advice', coaching: state.coaching };
}

/** True when the mode has a hint to offer that the player has not asked for yet. */
export function hintAvailable(state: TableState, mode: HintMode): boolean {
  return (
    mode === 'on-request' &&
    !state.hintRequested &&
    state.pending.length === 0 &&
    state.coaching !== null
  );
}

// --- The running tally -----------------------------------------------------

/**
 * The report card so far (SPEC §9), over what the player has been shown.
 *
 * `decisions` advances on the tap and `rounds` on the draw, so a verdict is
 * visible before the money it moved. That skew is deliberate and self-clearing:
 * it is what a real table looks like, where you know you misplayed before the
 * dealer has finished paying the row.
 *
 * `EMPTY_JERK_TALLY` because Jerk Mode is not wired up — every bot at this
 * table plays the book, so SPEC §7 has nothing to count. Reporting a fabricated
 * tally would be worse than reporting an empty one.
 */
export function tally(state: TableState): SessionReport {
  return sessionReport({
    decisions: state.decisions,
    rounds: roundResults(state.log, state.session.playerSeat),
    jerk: EMPTY_JERK_TALLY,
  });
}
