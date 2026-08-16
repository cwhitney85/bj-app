/**
 * The app (SPEC §9).
 *
 * A `switch` over `Route`, plus the two pieces of state that outlive any one
 * screen: where we are, and the settings. Nothing else lives here — every screen
 * owns its own working state, and the table owns the session.
 *
 * **Two invariants this file exists to keep, both of which the felt used to
 * break by itself.**
 *
 * 1. *A dealt table is never re-dealt underneath the player.* `TableScreen` is
 *    keyed on `config.seed`, so a new config mounts a new table with a new
 *    session rather than mutating a live one — and a config that has not changed
 *    cannot remount. `useTable` reads its config once, at mount, which is only
 *    safe because of this key.
 * 2. *Opening settings does not end the session.* Settings is a modal, held in a
 *    boolean here rather than on `Route`, so the table stays mounted beneath it.
 *    See `route.ts` for the longer version.
 *
 * **The seed.** The engine may not call `Date.now()` (SPEC §3) and does not; the
 * app may, and this is the one place it does. Every session gets a fresh shoe,
 * and the seed is on the config so a session that produced an interesting report
 * is reproducible from it.
 *
 * **This directory is `shell/` and must not be renamed to `app/`.** `src/app` is
 * Expo Router's reserved convention: with the directory present, Metro announces
 * "Using src/app as the root directory for Expo Router" and begins treating every
 * file in it as a route. This app is not a Router app — `index.ts` registers
 * `App.tsx` — so the two conventions would be competing to own the same files.
 * It bundled clean when it was tried, which is the problem: `tsc` cannot see a
 * Metro convention at all, so the first symptom would arrive at runtime. Same
 * class of fault as decision 59.
 */

import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';

import { SessionReportScreen } from '../report/SessionReportScreen';
import { SeatSelectScreen } from '../seat/SeatSelectScreen';
import type { SeatDraft } from '../seat/seatDraft';
import { SettingsScreen } from '../settings/SettingsScreen';
import { TableScreen } from '../table/TableScreen';
import type { HintMode } from '../table/tableState';
import { HomeScreen } from './HomeScreen';
import { dealt, dealtAgain, finished, HOME, SEAT_SELECT, type Route } from './route';

/** Whatever `Date.now()` returns is a fine shoe seed; it need not be unguessable. */
function newSeed(): number {
  return Date.now() >>> 0;
}

export function AppShell() {
  const [route, setRoute] = useState<Route>(HOME);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hintMode, setHintMode] = useState<HintMode>('always');

  function screenFor(current: Route) {
    switch (current.screen) {
      case 'home':
        return (
          <HomeScreen
            onPlay={() => setRoute(SEAT_SELECT)}
            onSettings={() => setSettingsOpen(true)}
          />
        );

      case 'seat-select':
        return (
          <SeatSelectScreen
            onBack={() => setRoute(HOME)}
            onDeal={(draft: SeatDraft) => setRoute(dealt(draft, newSeed()))}
          />
        );

      case 'table':
        return (
          <TableScreen
            key={current.config.seed}
            config={current.config}
            hintMode={hintMode}
            onSettings={() => setSettingsOpen(true)}
            onEndSession={(report) => setRoute(finished(current.config, report))}
          />
        );

      case 'report':
        return (
          <SessionReportScreen
            report={current.report}
            onPlayAgain={() => setRoute(dealtAgain(current.config, newSeed()))}
            onHome={() => setRoute(HOME)}
          />
        );
    }
  }

  return (
    <>
      <StatusBar style="light" />
      {screenFor(route)}
      {settingsOpen ? (
        <SettingsScreen
          hintMode={hintMode}
          onHintMode={setHintMode}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
