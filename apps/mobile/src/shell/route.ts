/**
 * Where the app is (SPEC §9).
 *
 * Four screens, one linear flow: home → seat select → table → report → home.
 * No navigator library. A `Route` is a discriminated union and the shell is a
 * `switch` over it, which is the same shape every other decision in this
 * codebase takes and costs a dependency less than `react-navigation` for a graph
 * with no stack, no tabs, no deep links and no back gesture to honour.
 *
 * **Settings is not on this union, and that is load-bearing.** It opens over
 * whatever screen is showing, as a modal, because a route change unmounts the
 * screen it leaves — and unmounting the table destroys the session, the event
 * log and the report being accumulated from it. Making settings a route would
 * make "check my hint mode" cost the player their session. Making it a modal
 * makes that unreachable rather than merely avoided.
 *
 * **What each variant carries is what the screen after it needs and cannot
 * recompute.** `report` carries the config as well as the numbers so "play
 * again" can re-deal the same seating; a report screen that only had the report
 * would have to send the player back through seat select to sit down again.
 */

import type { SessionReport } from '@bj/engine';

import type { TableConfig } from '../table/tableState';
import { configFrom, type SeatDraft } from '../seat/seatDraft';

export type Route =
  | { readonly screen: 'home' }
  | { readonly screen: 'seat-select' }
  /** Dealt. `config` is fixed for the life of this route — see `dealt` below. */
  | { readonly screen: 'table'; readonly config: TableConfig }
  | {
      readonly screen: 'report';
      readonly report: SessionReport;
      /** The table the report is about, so it can be dealt again. */
      readonly config: TableConfig;
    };

export const HOME: Route = { screen: 'home' };
export const SEAT_SELECT: Route = { screen: 'seat-select' };

/**
 * Sit down.
 *
 * Precondition: the player has taken a seat (`canDeal`). `configFrom` throws
 * otherwise, which is right — a table the player is not at has no seat for any
 * per-seat figure the app renders to be about. The screen keeps it by disabling
 * "Start game" until a chair is taken.
 *
 * **Postcondition: the returned `config` is immutable for as long as this route
 * is current.** `openTableState` reads it once, at mount, and nothing re-reads
 * it — so a config that changed in place would leave the felt showing hands
 * played under seating the config no longer describes. The shell keeps the
 * guarantee by holding the route in state and keying the table on
 * `config.seed`, so a genuinely new config remounts rather than mutating.
 *
 * Note what is *not* fixed by this: who plays badly. That is `TableState.jerk`
 * and changes whenever the player says so, because it re-derives the deciders
 * rather than the table.
 */
export function dealt(draft: SeatDraft, seed: number): Route {
  return { screen: 'table', config: configFrom(draft, seed) };
}

/**
 * End the session and show the report card.
 *
 * Precondition: `report` was taken from the table dealt from `config`. Nothing
 * here can check it — `SessionReport` carries no seed — and it is the same
 * unenforceable pairing `SessionLog` documents in report.ts. The shell satisfies
 * it by reading both out of one `Table`.
 */
export function finished(config: TableConfig, report: SessionReport): Route {
  return { screen: 'report', report, config };
}

/**
 * Deal the same table again with a fresh shoe.
 *
 * Same seats, same bots, same habit assignment rule — a new `seed`, so it is a
 * new session and not a replay. Reusing the seed would deal the identical shoe,
 * which is a debugging tool (replay.ts) and not what "play again" means.
 */
export function dealtAgain(config: TableConfig, seed: number): Route {
  return { screen: 'table', config: { ...config, seed } };
}
