/**
 * The table screen's React binding.
 *
 * Every transition lives in `tableState.ts` as a pure function; what is left
 * here is `useState`, `useEffect`, `useCallback` and `useMemo`. The one piece of
 * behaviour this file owns is the *clock* — the engine advances on taps and the
 * queue drains on a timer, and `showEvents` is the only bridge between them.
 */

import type { Action, CoachSettings, SessionReport } from '@bj/engine';
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
  openTableState,
  requestHint,
  revealCheck,
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
  /** What the hint layer should draw, resolved against the current mode. */
  readonly hint: Hint | null;
  /** The mode has a hint the player has not asked for — draw the button. */
  readonly hintAvailable: boolean;
  readonly hintMode: HintMode;
  readonly setHintMode: (mode: HintMode) => void;
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
  readonly jerkMode: boolean;
  /**
   * SPEC §6's toggle. **Deals a new table**, and says so at the call site: who
   * sits where and how they play is setup fixed before a card is dealt
   * (shown.ts decision 56), so changing it mid-session would leave the felt
   * showing hands played under the old seating and the tally counting rounds
   * that were never played the way it says they were.
   */
  readonly setJerkMode: (on: boolean) => void;
};

export function useTable(initialConfig: TableConfig = DEFAULT_CONFIG): Table {
  const [config, setConfig] = useState(initialConfig);
  const deciders = useMemo(() => botDeciders(config), [config]);
  const [state, setState] = useState<TableState>(() => openTableState(config, deciders));
  const [hintMode, setHintMode] = useState<HintMode>('always');

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
    hint: hint(state, hintMode),
    hintAvailable: hintAvailable(state, hintMode),
    hintMode,
    setHintMode,
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
    jerkMode: config.jerkMode,
    setJerkMode: useCallback(
      (on: boolean) => {
        const next: TableConfig = { ...config, jerkMode: on };
        setConfig(next);
        setState(openTableState(next, botDeciders(next)));
      },
      [config],
    ),
  };
}
