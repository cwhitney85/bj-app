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
  addToTally,
  advanceUntilPlayer,
  assess,
  assignJerk,
  coach,
  counterfactual,
  createGame,
  createSession,
  deriveSeed,
  EMPTY_JERK_TALLY,
  flatBettor,
  JERK_POLICIES,
  mulberry32,
  openTable,
  PERFECT_POLICY,
  policyById,
  PURE_PLAY,
  roundResults,
  sessionReport,
  showEvents,
  submitAction,
  submitBet,
  submitInsurance,
  VEGAS_STRIP,
  type BotPolicy,
  type Choice,
  type Coaching,
  type CoachSettings,
  type Counterfactual,
  type Deciders,
  type Decision,
  type GameEvent,
  type JerkAssignment,
  type JerkTally,
  type PlayerPrompt,
  type RoundRecording,
  type SeatConfig,
  type SeatDecider,
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

/**
 * SPEC §7's offer, and its answer.
 *
 * The `Counterfactual` is computed whether or not the player ever taps — see
 * `closeShownRound` for why that is not wasted work but the only honest way to
 * do it. `revealed` is therefore about the screen and nothing else: the number
 * exists before the question is asked.
 */
export type JerkCheck = {
  readonly result: Counterfactual;
  /** The habit the seat was playing, for the copy. */
  readonly policy: BotPolicy;
  /** The player tapped "let's check". */
  readonly revealed: boolean;
};

/**
 * One finished round, waiting to be drawn, and who was playing badly while it
 * was played.
 *
 * **The assignment travels with the round because `state.jerk` cannot answer
 * for it.** `closeShownRound` runs on the draw clock, which lags the engine by
 * the whole animation queue — so by the time a round finishes on screen, the
 * player may have moved the habit to a different seat entirely. Correcting the
 * *current* jerk in a round it did not play would replay a seat that was already
 * following the book: `delta` of zero, verdict `unchanged`, and a tally quietly
 * accumulating false evidence for the myth SPEC §7 exists to refute. Nothing
 * would throw and every number would look reasonable. It is the same failure
 * `SessionLog` warns about in report.ts — arithmetically correct and about
 * nobody — and the same fix: score against what was actually in force.
 */
export type PendingRound = {
  readonly recording: RoundRecording;
  /**
   * The assignment in force while this round was played, or `null` when no
   * honest comparison exists for it. `null` has exactly two causes and they mean
   * the same thing operationally: nobody was playing badly, or the round
   * straddled a change and was played half under each assignment.
   */
  readonly jerk: JerkAssignment | null;
};

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

  // --- SPEC §7 -------------------------------------------------------------

  /**
   * Which seat plays badly and how, right now, or `null` for nobody.
   *
   * **Mutable, and that is why `PendingRound` exists.** The player may move the
   * habit to any bot seat or clear it at any moment (`setJerk`), so this field
   * answers "who is playing badly" and cannot answer "who was playing badly
   * during the round now finishing on the felt". Those are different questions
   * whenever the felt lags the engine, which is always.
   */
  readonly jerk: JerkAssignment | null;
  /**
   * A jerk change landed while a round was in flight, so that round was played
   * half under each assignment. Cleared when the round it spoils is stamped.
   */
  readonly jerkStraddled: boolean;
  /**
   * Rounds the *engine* has finished whose last card the player has not yet
   * been shown. They arrive on `step.completedRounds` at the tap and leave on
   * the draw clock, which is the whole reason this queue exists rather than the
   * recordings being consumed where they arrive.
   */
  readonly unshownRounds: readonly PendingRound[];
  /**
   * Events drawn since the last `RoundStarted`, i.e. the round currently on the
   * felt. `counterfactual` needs the round's *actual* events to compare
   * against, and these are the ones the player has actually seen.
   */
  readonly shownRoundEvents: readonly GameEvent[];
  /** SPEC §7's running count, over every round drawn — never only the checked ones. */
  readonly jerkTally: JerkTally;
  /** The offer for the round just finished on screen, or `null`. */
  readonly jerkCheck: JerkCheck | null;
};

export type TableConfig = {
  readonly seed: number;
  readonly playerSeat: number;
  readonly botSeats: readonly number[];
  readonly bankroll: number;
  readonly botBet: number;
  readonly coachSettings: CoachSettings;
  /**
   * SPEC §6: deal with one bot seat already holding a bad habit.
   *
   * Named for what it does rather than for a mode, because there is no longer a
   * mode: who plays badly is `TableState.jerk` and changes whenever the player
   * says so. This only decides where that starts.
   */
  readonly startWithJerk: boolean;
};

/**
 * The headless default: one fixed table, so the suites here and in `jerk.test.ts`
 * drive something reproducible without a screen.
 *
 * **Not the production path.** Seat select builds its config with `configFrom`
 * (seatDraft.ts) from what the player chose, and mints a fresh seed per session.
 * `route.test.ts` asserts the two agree, so this fixture cannot drift into
 * describing a table the app can no longer deal.
 */
export const DEFAULT_CONFIG: TableConfig = {
  seed: 20260812,
  /** Bottom-centre in the eventual 2.5D arc (SPEC §9). */
  playerSeat: 3,
  botSeats: [2, 4],
  bankroll: 500,
  botBet: 25,
  coachSettings: PURE_PLAY,
  startWithJerk: true,
};

/**
 * Where the bad habit starts (SPEC §6).
 *
 * **`assignJerk` picks the seat; `habitFor` decides the habit.** Taking the
 * policy `assignJerk` also returns would give a seat two possible habits
 * depending on how the player reached it — the one drawn at deal, or the one
 * `habitFor` gives after moving the habit away and back. Same seat, same seed,
 * different bad player. One rule for "what does seat N play", and this is the
 * call site that would otherwise have been the exception to it.
 *
 * Both draws derive from the seed under their own labels (M3 decision 23), so
 * neither can move a single card. That is what makes the counterfactual a
 * comparison rather than two unrelated shoes, and it is asserted rather than
 * trusted.
 */
export function openingJerk(config: TableConfig): JerkAssignment | null {
  if (!config.startWithJerk) return null;
  const drawn = assignJerk(config.seed, config.botSeats);
  return drawn === null ? null : { seat: drawn.seat, policy: habitFor(config.seed, drawn.seat) };
}

/**
 * The habit a given seat plays when it is the one playing badly.
 *
 * **A function of the seat, not of when it was chosen**, so moving the habit
 * from seat 2 to seat 5 and back gives seat 5 the same personality both times.
 * The alternative — redrawing on each move — makes the demo's subject change
 * identity while the player is watching it, and makes a session unreproducible
 * from its seed even though the cards are identical.
 *
 * Derived under its own per-seat label for the same reason `assignJerk` is:
 * choosing a habit must not consume the shuffle's stream, or picking a different
 * bad player would deal a different game and the counterfactual would be
 * comparing two unrelated shoes.
 */
export function habitFor(seed: number, seat: number): BotPolicy {
  const rng = mulberry32(deriveSeed(seed, `jerk-seat-${seat}`));
  const policy = JERK_POLICIES[rng.nextInt(JERK_POLICIES.length)];
  if (policy === undefined) {
    throw new Error('habitFor: index out of range'); // unreachable: bound is the array length
  }
  return policy;
}

/**
 * Hand the bad habit to a seat, or to nobody.
 *
 * Preconditions, both caller bugs and both thrown: `seat` is a bot seat at this
 * table, or `null`. Handing the habit to the player's own chair or to an empty
 * one would produce a `correctedSeat` that `counterfactual` refuses (it throws
 * when the corrected and observed seats are the same) or that no decider will
 * ever consult — a table where the label and the play have come apart.
 *
 * **Postcondition: the round in flight is spoiled for the tally.** A change
 * landing mid-round means the bots before the player acted under one assignment
 * and the bots after it under another, so no single seat can be corrected to
 * produce an honest comparison. `jerkStraddled` marks it; `answer` converts that
 * into a `null` stamp on the round when it completes. A change made at a bet
 * prompt costs nothing, because no cards are out.
 */
export function setJerk(state: TableState, config: TableConfig, seat: number | null): TableState {
  if (seat !== null && !config.botSeats.includes(seat)) {
    throw new Error(`setJerk: seat ${seat} holds no bot at this table`);
  }

  const jerk: JerkAssignment | null =
    seat === null ? null : { seat, policy: habitFor(config.seed, seat) };

  if (jerk?.seat === state.jerk?.seat) return state;

  return {
    ...state,
    jerk,
    // A bet prompt is the one moment nothing is in flight: the round has not
    // been played, so there is nothing to have straddled.
    jerkStraddled: state.jerkStraddled || state.prompt.kind !== 'bet',
  };
}

/**
 * The one habit that consumes no cards (replay.ts decision 30), and therefore
 * the one that must never be offered for checking: insurance is a side bet, so
 * its counterfactual is exactly `unchanged` every round by construction. Asking
 * "did that cost you?" about a play that provably cannot is a question the app
 * already knows the answer to.
 *
 * Held as a constant and resolved through `policyById` at module load so a typo
 * throws here rather than silently re-enabling the prompt.
 */
const CARD_NEUTRAL_JERK: BotPolicy = policyById('always-insures');

// --- Sitting down ----------------------------------------------------------

export function openTableState(config: TableConfig, deciders: Deciders): TableState {
  const game = createGame({ rules: VEGAS_STRIP, seed: config.seed, seats: seating(config) });
  const step = advanceUntilPlayer(createSession(game), deciders);
  const jerk = openingJerk(config);
  return {
    ...arriveAt(step, config.coachSettings),
    felt: openTable(game.seats),
    reviewed: null,
    log: [],
    decisions: [],
    jerk,
    jerkStraddled: false,
    unshownRounds: step.completedRounds.map((recording) => ({ recording, jerk })),
    shownRoundEvents: [],
    jerkTally: EMPTY_JERK_TALLY,
    jerkCheck: null,
  };
}

/**
 * Who occupies each chair.
 *
 * **The seating chart no longer names the jerk, and every bot is seated as
 * `PERFECT_POLICY`.** It used to bake the habit into `occupant.policyId`, which
 * was correct while the assignment was immutable and became a lie the moment it
 * could move: the chart is written once at `createGame` and never rewritten, so
 * a player moving the habit to another seat would leave the chart naming
 * somebody who had stopped playing badly.
 *
 * The old invariant was "the chart and the deciders must agree about who the
 * jerk is". It is replaced by a stronger one — **only `TableState.jerk` knows**,
 * and the deciders are derived from it on every advance. Two sources of truth
 * that must be kept in agreement is a weaker guarantee than one source, and
 * `occupant.policyId` was the one that could not be updated.
 *
 * Nothing reads `policyId` in the app; `occupantPolicyId` (play.ts) is the only
 * reader in the repo and has no call site. If a screen ever wants "what is this
 * seat playing", it wants `state.jerk`, which is live.
 */
export function seating(config: TableConfig): readonly SeatConfig[] {
  return Array.from({ length: VEGAS_STRIP.seatCount }, (_, index): SeatConfig => {
    if (index === config.playerSeat) {
      return { occupant: { kind: 'player' }, bankroll: config.bankroll };
    }
    if (config.botSeats.includes(index)) {
      return {
        occupant: {
          kind: 'bot',
          policyId: PERFECT_POLICY.id,
          characterId: `seat-${index}`,
        },
        bankroll: config.bankroll,
      };
    }
    return { occupant: { kind: 'empty' }, bankroll: 0 };
  });
}

/**
 * How each bot seat plays, right now.
 *
 * Takes the assignment rather than reading it off the config, because it is
 * `TableState.jerk` that changes and the config that does not. Re-derived on
 * every advance, which is free: `Deciders` is an argument to the transitions
 * rather than a field on the state (M4 decision 33), so swapping a policy
 * mid-session needs no engine state to be rewritten and cannot invalidate a hand
 * already in progress.
 */
/**
 * The deciders a table is dealt with — `botDeciders` under the opening
 * assignment.
 *
 * Exists so the pairing has one name. `openTableState` computes the opening
 * assignment internally, and a caller that passed deciders built from a
 * *different* assignment would deal a table whose `state.jerk` names one seat
 * while the deciders hand the habit to another — the exact "label and play come
 * apart" failure the old `seating` comment warned about, relocated. There is now
 * one expression that cannot get it wrong.
 */
export function openingDeciders(config: TableConfig): Deciders {
  return botDeciders(config, openingJerk(config));
}

export function botDeciders(config: TableConfig, jerk: JerkAssignment | null): Deciders {
  return new Map(
    config.botSeats.map((seat) => [
      seat,
      solvent(
        flatBettor(jerk !== null && jerk.seat === seat ? jerk.policy : PERFECT_POLICY, config.botBet),
        config.botBet,
      ),
    ]),
  );
}

/**
 * Sit a round out rather than betting money the seat does not have.
 *
 * `flatBettor` states an *intent* — "this seat stakes $25 a round" — and
 * `validateBet` **throws** when a seat cannot cover it. That division is right
 * and matches M3 decision 25, where a policy that always insures has its wish
 * resolved against the bankroll by the driver rather than by the personality.
 * Bets had no such resolution anywhere, because nothing had ever played long
 * enough to need one.
 *
 * It matters more than it looks, and the arithmetic is the argument. A bot
 * playing the book loses ~0.4% of a bet per round, so a $500 seat flat-betting
 * $25 survives for thousands of rounds and the throw is effectively
 * unreachable. `mimics-dealer` loses **6.3%** per round (PLAN, M3) and is
 * broke in about 300 — and the throw takes down the whole table, not the seat.
 * So **turning on Jerk Mode is what makes an existing crash reachable**, and it
 * was found by the §7 tests, which were the first thing in this repo to play
 * that many consecutive rounds through the app.
 */
function solvent(decider: SeatDecider, stake: number): SeatDecider {
  return {
    ...decider,
    bet: (view) => {
      // Push out what is left when it is short of the intended stake — which is
      // what a player with three chips does — and sit out below the minimum,
      // where no legal bet exists. 0 is how `collectBets` is told to skip.
      const affordable = Math.min(stake, view.seat.bankroll);
      return affordable < view.rules.minBet ? 0 : affordable;
    },
  };
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

  const drawn: TableState = {
    ...state,
    felt: showEvents(state.felt, [next]),
    pending: rest,
    log: [...state.log, next],
    shownRoundEvents: [...state.shownRoundEvents, next],
  };

  // A *drawn* `RoundStarted` is the round boundary, and it is the same boundary
  // `roundResults` splits on (report.ts decision 49): it is emitted in exactly
  // one place and lands two phases after the settlements it follows, so
  // everything before it is one complete round, in full, on the felt.
  return next.type === 'RoundStarted' ? closeShownRound(drawn, next) : drawn;
}

/**
 * Draw everything still queued — the "skip animation" control.
 *
 * Iterated `drawNext` rather than one `showEvents` call, so there is exactly
 * one definition of what drawing an event does. `showEvents` is a fold, so the
 * felt and the log are unchanged by this; the round boundary and the §7 tally
 * are the parts that would otherwise have needed a second implementation, and a
 * second implementation of "when is a round over" is how the two answers drift.
 */
export function drawAll(state: TableState): TableState {
  let drawn = state;
  while (drawn.pending.length > 0) drawn = drawNext(drawn);
  return drawn;
}

/**
 * The round on the felt has ended. Price what the bad player did to it (SPEC §7).
 *
 * **The tally counts every completed round, not the ones the player asked
 * about.** SPEC §7 describes the prompt and the tally in the same breath, and
 * reading it as "tapping is what counts" is the one mistake that breaks the
 * feature: the prompt is only offered when the player *lost*, so a tap-driven
 * tally samples losses and converges on "hurt". It would teach the myth this
 * demo exists to refute, and every number on it would look reasonable. So the
 * counterfactual runs on every round and `jerkCheck` decides only what is shown.
 *
 * Precondition: `shownRoundEvents` opens with the `RoundStarted` of the round
 * being closed, and at most one recording is waiting for it. Rounds are drawn
 * in order and each completed round emits exactly one `RoundStarted` after it
 * (M3 decision 21), so a stranded recording means the engine's round identity
 * has broken rather than this function has. Asserted in the tests rather than
 * thrown here — crashing an animation tick is the wrong response to a
 * miscounted statistic.
 */
function closeShownRound(state: TableState, opening: GameEvent): TableState {
  // Everything drawn before the boundary is the round that just ended; the
  // boundary itself opens the next one.
  const closed = state.shownRoundEvents.slice(0, -1);
  const reopened = [opening];
  const head = closed[0];

  // The very first drawn event is `RoundStarted(1)`: nothing precedes it, so
  // there is no round to close and no recording can be waiting.
  if (head === undefined || head.type !== 'RoundStarted') {
    return { ...state, shownRoundEvents: reopened };
  }

  const pending = state.unshownRounds.find(
    (round) => round.recording.roundNumber === head.roundNumber,
  );
  if (pending === undefined) {
    return { ...state, shownRoundEvents: reopened };
  }

  // Spent either way: a round with no honest comparison is still a round the
  // player has now watched, and leaving it queued would strand it forever and
  // let a later round match the wrong recording.
  const spent = state.unshownRounds.filter((round) => round !== pending);

  // The assignment this round was *played* under, not the one in force now.
  const jerk = pending.jerk;
  if (jerk === null) {
    return { ...state, shownRoundEvents: reopened, unshownRounds: spent };
  }

  const result = counterfactual(pending.recording, closed, {
    correctedSeat: jerk.seat,
    observedSeat: state.session.playerSeat,
  });

  return {
    ...state,
    shownRoundEvents: reopened,
    unshownRounds: spent,
    jerkTally: addToTally(state.jerkTally, result),
    jerkCheck: offersCheck(result, jerk.policy)
      ? { result, policy: jerk.policy, revealed: false }
      : null,
  };
}

/**
 * SPEC §7: the prompt appears when a bad play "visibly precedes the player
 * losing a hand". Losing is the trigger the spec names, and it is the right one
 * — the feeling the demo answers is the one a player only has after a loss.
 *
 * The card-neutral habit is excluded by name rather than by its verdict. Every
 * one of its rounds is `unchanged`, so gating on the verdict would exclude it
 * too, and would also hide the ordinary `unchanged` rounds — which are ~91% of
 * them and the most useful thing the demo has to say.
 */
function offersCheck(result: Counterfactual, policy: BotPolicy): boolean {
  return policy.id !== CARD_NEUTRAL_JERK.id && result.actual.net < 0;
}

/** The player tapped "let's check". Reveals a number that already existed. */
export function revealCheck(state: TableState): TableState {
  if (state.jerkCheck === null || state.jerkCheck.revealed) return state;
  return { ...state, jerkCheck: { ...state.jerkCheck, revealed: true } };
}

export function dismissCheck(state: TableState): TableState {
  return state.jerkCheck === null ? state : { ...state, jerkCheck: null };
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

  const step = advance(state.session);

  return {
    ...state,
    ...arriveAt(step, settings),
    // A bet prompt clears the review: the verdict belongs to the hand it was
    // made on, and that hand is over.
    reviewed: scored,
    decisions: scored === null ? state.decisions : [...state.decisions, scored.decision],
    // Queued, not consumed. The engine has finished these rounds; the player
    // has not yet watched them finish, and SPEC §7's verdict is about money
    // they have seen change hands. `closeShownRound` is where they are spent.
    //
    // Stamped here, with the assignment that was in force while they were
    // played — which is `state.jerk` at this instant, because `setJerk` can only
    // run between advances. Reading it again at draw time would read whatever
    // the player has since chosen. See `PendingRound`.
    unshownRounds: [...state.unshownRounds, ...stamp(state, step.completedRounds)],
    // **Cleared only once it has spoiled a round, not on the next tap.** A
    // change made mid-round is usually followed by several more decisions
    // before that round ends — hit, hit, stand — and an advance that completes
    // no round has had nothing to mark. Clearing it there would let the flag
    // expire unused and the straddled round be stamped with the current
    // assignment after all, which is the exact misattribution it exists to
    // prevent.
    jerkStraddled: state.jerkStraddled && step.completedRounds.length === 0,
  };
}

/**
 * Attach the assignment in force to each round that just completed.
 *
 * **Only the first round can have been straddled**, because a straddle is a
 * change made while a round was in flight and only one round can be in flight at
 * a time. Any further rounds in the same batch began after the change and were
 * played wholly under the new assignment. Batches of more than one arise when a
 * tap plays several rounds through — a player sitting out, most often.
 */
function stamp(
  state: TableState,
  completed: readonly RoundRecording[],
): readonly PendingRound[] {
  return completed.map((recording, index) => ({
    recording,
    jerk: index === 0 && state.jerkStraddled ? null : state.jerk,
  }));
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
 * `jerkTally` follows `rounds` onto the draw clock rather than `decisions` onto
 * the tap, and for the same reason: a §7 verdict is about money that has
 * already changed hands. With Jerk Mode off it is `EMPTY_JERK_TALLY` because
 * nothing was ever counted — which is now the truth rather than a placeholder.
 */
export function tally(state: TableState): SessionReport {
  return sessionReport({
    decisions: state.decisions,
    rounds: roundResults(state.log, state.session.playerSeat),
    jerk: state.jerkTally,
  });
}
