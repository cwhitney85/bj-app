/**
 * The table screen's React binding.
 *
 * Every transition lives in `tableState.ts` as a pure function; what is left
 * here is `useState`, `useEffect`, `useCallback` and `useMemo`. The one piece of
 * behaviour this file owns is the *clock* — the engine advances on taps and the
 * queue drains on a timer, and `showEvents` is the only bridge between them.
 */

import type { Action, CoachSettings, RuleSet, SessionReport } from '@bj/engine';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  act,
  bet,
  botDeciders,
  DEFAULT_CONFIG,
  dismissCheck,
  drawAll,
  drawNext,
  hint,
  hintAvailable,
  insure,
  openingDeciders,
  openTableState,
  requestHint,
  revealCheck,
  setJerk,
  tally,
  type Hint,
  type HintMode,
  type TableConfig,
  type TableState,
} from './tableState';

/** How long one event sits on screen. The engine never waits on this. */
const DRAW_INTERVAL_MS = 220;

export type Table = TableState & {
  /** The felt has caught up, so the player may act. */
  readonly caughtUp: boolean;
  readonly playerSeat: number;
  /**
   * The rules this table is dealt under — for what the felt has printed on it
   * and for the discard tray's depth.
   *
   * Read off `session.state`, which every other reader in the app is forbidden
   * (M4 decision 34: the state is the *future*, the felt is what has been
   * drawn). It is safe for exactly one reason, and only this field: a rule set
   * is table setup fixed before a card is dealt, so it is identical in the state
   * and on the felt at every instant and cannot run ahead of anything. Surfaced
   * here rather than read in a component so that "screens never touch
   * `session.state`" stays a rule with no exceptions in it.
   */
  readonly rules: RuleSet;
  /** What the hint layer should draw, resolved against the current mode. */
  readonly hint: Hint | null;
  /** The mode has a hint the player has not asked for — draw the button. */
  readonly hintAvailable: boolean;
  /** The report card so far (SPEC §9), over the events drawn. */
  readonly report: SessionReport;
  readonly placeBet: (amount: number) => void;
  readonly takeAction: (action: Action) => void;
  readonly takeInsurance: (take: boolean) => void;
  readonly askForHint: () => void;
  /** Draw everything still queued — the "skip animation" control. */
  readonly skip: () => void;
  /** SPEC §7: "Let's check." */
  readonly checkJerk: () => void;
  readonly dismissJerkCheck: () => void;
  /** Bot seats at this table, in seating order — the jerk picker's options. */
  readonly botSeats: readonly number[];
  /**
   * SPEC §6: hand the bad habit to a bot seat, or to nobody.
   *
   * Takes effect on the next decision any bot makes. It does **not** re-deal:
   * `Deciders` is an argument rather than engine state (M4 decision 33), so the
   * shoe, the seating and every hand in progress are untouched. The round in
   * flight is dropped from the §7 tally rather than misattributed — see
   * `setJerk` and `PendingRound`.
   */
  readonly setJerkSeat: (seat: number | null) => void;
};

/**
 * Drive one table.
 *
 * **Precondition: `config` is fixed for the life of the component.** It is read
 * exactly once, in the `useState` initialiser, because who sits where and how
 * they play is setup fixed before a card is dealt (shown.ts decision 56) — a
 * config that changed underneath a live session would leave the felt showing
 * hands played under seating the config no longer describes, and nothing would
 * throw. The caller keeps this by keying the component on `config.seed`, so a
 * genuinely different table mounts a different component (`AppShell`). This hook
 * used to hold the config in its own state and re-deal on a Jerk Mode toggle,
 * which honoured the same invariant by destroying the session; seat select owns
 * that choice now, before there is a session to destroy.
 *
 * `hintMode` is the opposite kind of input: it is a setting, it may change at any
 * moment, and it is pure presentation over coaching that was computed at the
 * prompt regardless of mode (decision 62). So it is a plain prop, re-read every
 * render, and changing it mid-hand is safe by construction.
 */
export function useTable(config: TableConfig = DEFAULT_CONFIG, hintMode: HintMode = 'always'): Table {
  const [state, setState] = useState<TableState>(() =>
    openTableState(config, openingDeciders(config)),
  );

  // Live: re-derived whenever the player moves the habit, so the next advance
  // is driven by whoever is playing badly *now*.
  const deciders = useMemo(() => botDeciders(config, state.jerk), [config, state.jerk]);

  const settings: CoachSettings = config.coachSettings;

  // The animation clock. One event per tick, so the felt lags the engine by
  // however long the queue is — which is exactly the point.
  useEffect(() => {
    if (state.pending.length === 0) return;
    const timer = setTimeout(() => setState(drawNext), DRAW_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [state.pending]);

  // `roundResults` rescans the whole log and `sessionReport` regroups every
  // decision, so this is O(session) and must not run per render.
  const report = useMemo(() => tally(state), [state.log, state.decisions, state.session]);

  return {
    ...state,
    caughtUp: state.pending.length === 0,
    playerSeat: state.session.playerSeat,
    rules: state.session.state.rules,
    hint: hint(state, hintMode),
    hintAvailable: hintAvailable(state, hintMode),
    report,
    placeBet: useCallback(
      (amount: number) => setState((s) => bet(s, amount, deciders, settings)),
      [deciders, settings],
    ),
    takeAction: useCallback(
      (action: Action) => setState((s) => act(s, action, deciders, settings)),
      [deciders, settings],
    ),
    takeInsurance: useCallback(
      (take: boolean) => setState((s) => insure(s, take, deciders, settings)),
      [deciders, settings],
    ),
    askForHint: useCallback(() => setState(requestHint), []),
    skip: useCallback(() => setState(drawAll), []),
    checkJerk: useCallback(() => setState(revealCheck), []),
    dismissJerkCheck: useCallback(() => setState(dismissCheck), []),
    botSeats: config.botSeats,
    setJerkSeat: useCallback(
      (seat: number | null) => setState((s) => setJerk(s, config, seat)),
      [config],
    ),
  };
}
