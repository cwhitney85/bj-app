/**
 * The table screen's state.
 *
 * Holds the two things M4 decision 34 requires and nothing else: a `ShownTable`,
 * which is what gets rendered, and a queue of events the engine has emitted but
 * the screen has not yet drawn. The engine advances on taps; the queue drains on
 * a timer. `showEvents` is the only bridge between them.
 *
 * `session.state` is never rendered. It is the future — one `submitAction` can
 * settle a round and deal into the next — so reading it would show the player
 * cards they have not been dealt.
 */

import {
  advanceUntilPlayer,
  createGame,
  createSession,
  flatBettor,
  openTable,
  PERFECT_POLICY,
  showEvents,
  submitAction,
  submitBet,
  submitInsurance,
  VEGAS_STRIP,
  type Action,
  type Deciders,
  type GameEvent,
  type PlayerPrompt,
  type SeatConfig,
  type Session,
  type SessionStep,
  type ShownTable,
} from '@bj/engine';
import { useCallback, useEffect, useState } from 'react';

/** Bottom-centre in the eventual 2.5D arc (SPEC §9). */
const PLAYER_SEAT = 3;
const BOT_SEATS = [2, 4];
const STARTING_BANKROLL = 500;
const BOT_BET = 25;

/** How long one event sits on screen. The engine never waits on this. */
const DRAW_INTERVAL_MS = 220;

type TableState = {
  readonly session: Session;
  readonly felt: ShownTable;
  readonly pending: readonly GameEvent[];
  readonly prompt: PlayerPrompt;
};

export type Table = TableState & {
  /** The felt has caught up, so the player may act. */
  readonly caughtUp: boolean;
  readonly playerSeat: number;
  readonly bet: (amount: number) => void;
  readonly act: (action: Action) => void;
  readonly insure: (take: boolean) => void;
  /** Draw everything still queued — the "skip animation" control. */
  readonly skip: () => void;
};

export function useTable(seed: number): Table {
  const [deciders] = useState<Deciders>(botDeciders);
  const [state, setState] = useState<TableState>(() => open(seed, deciders));

  // The animation clock. One event per tick, so the felt lags the engine by
  // however long the queue is — which is exactly the point.
  useEffect(() => {
    if (state.pending.length === 0) return;
    const timer = setTimeout(() => setState(draw), DRAW_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [state.pending]);

  const submit = useCallback(
    (advance: (session: Session) => SessionStep) => {
      setState((current) => {
        if (current.pending.length > 0) return current; // input is closed mid-draw
        const step = advance(current.session);
        return {
          session: step.session,
          felt: current.felt,
          pending: step.events,
          prompt: step.prompt,
        };
      });
    },
    [],
  );

  return {
    ...state,
    caughtUp: state.pending.length === 0,
    playerSeat: state.session.playerSeat,
    bet: useCallback(
      (amount: number) => submit((session) => submitBet(session, amount, deciders)),
      [submit, deciders],
    ),
    act: useCallback(
      (action: Action) => submit((session) => submitAction(session, action, deciders)),
      [submit, deciders],
    ),
    insure: useCallback(
      (take: boolean) => submit((session) => submitInsurance(session, take, deciders)),
      [submit, deciders],
    ),
    skip: useCallback(() => setState(drawAll), []),
  };
}

// --- The clock -------------------------------------------------------------

function draw(current: TableState): TableState {
  const [next, ...rest] = current.pending;
  if (next === undefined) return current;
  return { ...current, felt: showEvents(current.felt, [next]), pending: rest };
}

function drawAll(current: TableState): TableState {
  if (current.pending.length === 0) return current;
  return {
    ...current,
    felt: showEvents(current.felt, current.pending),
    pending: [],
  };
}

// --- Sitting down ----------------------------------------------------------

function open(seed: number, deciders: Deciders): TableState {
  const game = createGame({ rules: VEGAS_STRIP, seed, seats: seating() });
  const step = advanceUntilPlayer(createSession(game), deciders);
  return {
    session: step.session,
    felt: openTable(game.seats),
    pending: step.events,
    prompt: step.prompt,
  };
}

function seating(): readonly SeatConfig[] {
  return Array.from({ length: VEGAS_STRIP.seatCount }, (_, index): SeatConfig => {
    if (index === PLAYER_SEAT) {
      return { occupant: { kind: 'player' }, bankroll: STARTING_BANKROLL };
    }
    if (BOT_SEATS.includes(index)) {
      return {
        occupant: { kind: 'bot', policyId: PERFECT_POLICY.id, characterId: `seat-${index}` },
        bankroll: STARTING_BANKROLL,
      };
    }
    return { occupant: { kind: 'empty' }, bankroll: 0 };
  });
}

function botDeciders(): Deciders {
  return new Map(BOT_SEATS.map((seat) => [seat, flatBettor(PERFECT_POLICY, BOT_BET)]));
}
