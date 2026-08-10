/**
 * The interactive driver — a table with a human in one seat (SPEC §11, M4).
 *
 * `play.ts` drives a round when every seat can answer for itself. A human seat
 * cannot: the app has to stop, render, wait for a tap, and resume. This module
 * is that loop. It answers for every bot through the same `SeatDecider` door
 * `playRound` uses, and stops the instant the person in the chair owes an
 * answer.
 *
 * Three properties are deliberate.
 *
 * 1. **A `Session` is plain serialisable data**, like `RoundState` itself.
 *    Deciders are functions, so they are passed in on each call rather than
 *    stored — a session that held them could not be persisted (SPEC §9) and
 *    could not be compared for equality in a test.
 *
 * 2. **Every call returns at a `PlayerPrompt`.** There is no "advance a bit"
 *    mode, because a UI that had to decide when to stop would be re-deriving
 *    turn order. The events come back in one list and the UI drains them onto
 *    its own clock (SPEC §3) while the state has already moved on.
 *
 * 3. **Rounds are recorded here.** A recording is the round's start state plus
 *    its events (M3 decision 26), and this is the only object holding both at
 *    the right instant. Leaving it to the app would mean the app snapshotting
 *    `RoundState` at exactly the betting phase before `placeBets` — easy to get
 *    subtly wrong, and SPEC §7's demo is worthless if it is.
 *
 * This file adds no game logic. Every transition goes through `round.ts`, every
 * bot answer through `bots.ts`. `test/session.test.ts` pins that by driving a
 * session and `playRound` over the same seed and asserting the event streams are
 * identical — if this file ever starts deciding anything, that test breaks.
 */

import type { GameEvent } from './events.js';
import type { Action } from './hand.js';
import { collectBets, type Deciders } from './play.js';
import { recordRound, type RoundRecording } from './replay.js';
import {
  advance,
  applyAction,
  pendingDecision,
  placeBets,
  takeInsurance,
  type StepResult,
} from './round.js';
import { isOccupied, isPlayerSeat, type RoundState } from './state.js';
import {
  betView,
  insuranceView,
  actionView,
  type ActionView,
  type BetView,
  type InsuranceView,
} from './view.js';

/**
 * A game in progress, from the point of view of the one human at the table.
 *
 * `roundStart` and `roundEvents` are the in-flight recording. They are part of
 * the session rather than locals in the loop because a round spans several
 * calls — the player is asked to bet, then to act, and the recording has to
 * survive the gaps.
 */
export type Session = {
  readonly state: RoundState;
  /** Index of the human's seat. Fixed for the life of the session. */
  readonly playerSeat: number;
  /** Betting-phase state the current round began from; `null` before the first. */
  readonly roundStart: RoundState | null;
  /** Events emitted since `roundStart`. */
  readonly roundEvents: readonly GameEvent[];
};

/**
 * What the app must ask the player, right now.
 *
 * Distinct from `PendingDecision` because they answer different questions.
 * `PendingDecision` says what the *engine* is waiting for and is table-wide —
 * its `bets` and `insurance` variants list every seat. A prompt is about one
 * person, and carries the view the coaching layer needs (`recommend`,
 * `evaluateActions` and `explain` all take pieces of it) so the UI never
 * rebuilds one.
 */
export type PlayerPrompt =
  | {
      readonly kind: 'bet';
      readonly view: BetView;
      readonly min: number;
      /**
       * The most the player can stake: the table maximum, or their bankroll if
       * that is smaller. When `max < min` they cannot bet at all and the only
       * legal answer is 0 (sit the round out).
       */
      readonly max: number;
    }
  | {
      readonly kind: 'insurance';
      readonly view: InsuranceView;
      /** The stake in money, already resolved from `view.cost` and the base bet. */
      readonly stake: number;
    }
  | { readonly kind: 'action'; readonly view: ActionView };

export type SessionStep = {
  readonly session: Session;
  /** Everything that happened during this call, in order, for the animation queue. */
  readonly events: readonly GameEvent[];
  /** Always present: a call ends at a prompt or it throws. */
  readonly prompt: PlayerPrompt;
  /**
   * Rounds that finished during this call, ready for `counterfactual()`.
   * A list rather than a single value because settling one round and dealing
   * into the next happen in the same call — the caller keeps what it wants.
   */
  readonly completedRounds: readonly RoundRecording[];
};

/**
 * Precondition: exactly one seat is occupied by the player. Zero means nobody
 * would ever be prompted and the loop could not terminate; more than one means
 * "the player's seat" is not a well-defined thing, and SPEC §7's comparison —
 * what the jerk cost *you* — has no subject.
 */
export function createSession(state: RoundState): Session {
  const players = state.seats.filter(isPlayerSeat);
  const player = players[0];
  if (players.length !== 1 || player === undefined) {
    throw new Error(`createSession: expected exactly one player seat, got ${players.length}`);
  }
  return { state, playerSeat: player.index, roundStart: null, roundEvents: [] };
}

/**
 * Run the table until the player has to answer.
 *
 * Bots act, cards are dealt, the dealer plays and the round settles, all inside
 * this call. It returns at the first thing the player owes: a bet, an insurance
 * answer, or an action.
 */
export function advanceUntilPlayer(session: Session, deciders: Deciders): SessionStep {
  return advanceToPrompt(session, deciders, []);
}

/**
 * Place the player's bet — 0 to sit the round out — and run on.
 *
 * Bot stakes are collected here rather than by the caller, so the app never
 * holds a half-filled bet map. `collectBets` skips seats without a decider,
 * which is exactly the player's seat.
 */
export function submitBet(session: Session, amount: number, deciders: Deciders): SessionStep {
  requireDeciders(session, deciders);
  const bets = collectBets(session.state, deciders);
  if (amount > 0) bets.set(session.playerSeat, amount);
  else bets.delete(session.playerSeat);
  return resume(session, deciders, placeBets(session.state, bets));
}

/**
 * Answer the insurance offer for the player.
 *
 * Note this does *not* collapse an unaffordable "yes" into a "no", which is
 * what `play.ts` does for bots (M3 decision 25). The asymmetry is intentional:
 * a bot personality describes an *intent* that the table resolves, whereas a
 * human tap is a request, and quietly declining a bet the player asked for
 * would be the app lying about what it did. The prompt carries `stake` and the
 * seat's bankroll precisely so the UI can refuse to offer it; taking one it
 * cannot cover is a caller bug, and `takeInsurance` names it as one.
 */
export function submitInsurance(session: Session, take: boolean, deciders: Deciders): SessionStep {
  requireDeciders(session, deciders);
  return resume(session, deciders, takeInsurance(session.state, session.playerSeat, take));
}

/**
 * Play the player's action. Illegality is `applyAction`'s to reject — deviating
 * from the book is not (SPEC §5.5: never blocked, never scolded, only recorded).
 */
export function submitAction(session: Session, action: Action, deciders: Deciders): SessionStep {
  requireDeciders(session, deciders);
  return resume(session, deciders, applyAction(session.state, session.playerSeat, action));
}

// --- The loop --------------------------------------------------------------

/** Fold one transition into the session, then carry on to the next prompt. */
function resume(session: Session, deciders: Deciders, step: StepResult): SessionStep {
  const moved: Session = {
    ...session,
    state: step.state,
    roundEvents: [...session.roundEvents, ...step.events],
  };
  return advanceToPrompt(moved, deciders, step.events);
}

function advanceToPrompt(
  session: Session,
  deciders: Deciders,
  emitted: readonly GameEvent[],
): SessionStep {
  requireDeciders(session, deciders);

  const events: GameEvent[] = [...emitted];
  const completedRounds: RoundRecording[] = [];
  let current = session.state;
  let roundStart = session.roundStart;
  let roundEvents: GameEvent[] = [...session.roundEvents];

  if (roundStart === null && current.phase === 'betting') roundStart = current;

  const stop = (prompt: PlayerPrompt): SessionStep => ({
    session: { state: current, playerSeat: session.playerSeat, roundStart, roundEvents },
    events,
    prompt,
    completedRounds,
  });

  const record = (step: StepResult): void => {
    events.push(...step.events);
    roundEvents.push(...step.events);
    current = step.state;
  };

  let guard = 0;
  for (;;) {
    if (++guard > 10_000) throw new Error('advanceUntilPlayer: never reached a player decision');
    const decision = pendingDecision(current);

    if (decision === null) {
      const step = advance(current);
      // `roundNumber` moves in exactly one place — `idle` -> `betting` — so a
      // change here means the round that `roundStart` opened has just closed,
      // and this step's lone `RoundStarted` belongs to the next one. Hence the
      // check before the events are filed rather than after.
      if (roundStart !== null && step.state.roundNumber !== roundStart.roundNumber) {
        completedRounds.push(recordRound(roundStart, roundEvents));
        roundStart = null;
        roundEvents = [];
      }
      record(step);
      if (roundStart === null && current.phase === 'betting') roundStart = current;
      continue;
    }

    switch (decision.kind) {
      case 'bets':
        return stop(betPrompt(current, session.playerSeat));

      case 'insurance': {
        // Seat order, and the player's turn in it, is preserved: we answer bots
        // ahead of the player and return before touching those behind, who are
        // answered when the loop resumes. Insurance consumes no cards, so this
        // could not shift one — but the event stream is compared against
        // `playRound` byte for byte, and order is part of that.
        for (const seatIndex of decision.seats) {
          if (seatIndex === session.playerSeat) {
            return stop(insurancePrompt(current, seatIndex, decision.cost));
          }
          const decider = requireDecider(deciders, seatIndex);
          const view = insuranceView(current, seatIndex, decision.cost);
          const wants = decider.takeInsurance(view);
          const stake = view.seat.baseBet * decision.cost;
          record(takeInsurance(current, seatIndex, wants && stake <= view.seat.bankroll));
        }
        break;
      }

      case 'action': {
        if (decision.seat === session.playerSeat) {
          return stop({ kind: 'action', view: actionView(current, decision.seat) });
        }
        const decider = requireDecider(deciders, decision.seat);
        record(applyAction(current, decision.seat, decider.act(actionView(current, decision.seat))));
        break;
      }
    }
  }
}

// --- Prompts ---------------------------------------------------------------

function betPrompt(state: RoundState, seatIndex: number): PlayerPrompt {
  const view = betView(state, seatIndex);
  return {
    kind: 'bet',
    view,
    min: state.rules.minBet,
    max: Math.min(state.rules.maxBet, view.seat.bankroll),
  };
}

function insurancePrompt(state: RoundState, seatIndex: number, cost: number): PlayerPrompt {
  const view = insuranceView(state, seatIndex, cost);
  return { kind: 'insurance', view, stake: view.seat.baseBet * cost };
}

// --- Preconditions ---------------------------------------------------------

/**
 * Checked up front rather than at the point of use, because the failure is
 * otherwise invisible: `collectBets` skips a seat it has no decider for, so a
 * bot missing one would quietly sit out every round instead of failing.
 */
function requireDeciders(session: Session, deciders: Deciders): void {
  const missing = session.state.seats
    .filter((seat) => isOccupied(seat) && !isPlayerSeat(seat) && !deciders.has(seat.index))
    .map((seat) => seat.index);
  if (missing.length > 0) {
    throw new Error(`session: no decider for occupied seat(s) ${missing.join(', ')}`);
  }
}

function requireDecider(deciders: Deciders, seatIndex: number) {
  const decider = deciders.get(seatIndex);
  if (decider === undefined) throw new Error(`session: no decider for seat ${seatIndex}`);
  return decider;
}
