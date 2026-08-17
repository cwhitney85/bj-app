/**
 * The table (SPEC §9).
 *
 * Everything on the felt is drawn from the `ShownTable` the hook folds out of
 * the event stream, never from `session.state` — see M4 decision 34, and
 * `useTable.rules` for the one field that is allowed across that line and why.
 *
 * **This screen is now a layout, not a stack.** It used to be a `ScrollView`
 * with `paddingBottom: 96` clearing an action bar that floated over the seats,
 * and a hint card inserted above the controls with a `maxHeight` picked by eye.
 * Both were placeholders and PLAN listed both as gaps. There are four things
 * competing for the screen — the felt, the §7 offer, the hint, the buttons — and
 * they are now laid out in one column that adds up: the felt takes what is left
 * after the other three have taken what they need. Nothing overlaps, so nothing
 * needs clearing.
 *
 * That is only possible because three controls left in the previous pass. A
 * six-participant layout has no honest solution on a phone; a four-participant
 * one does.
 */

import type { Action, SessionReport } from '@bj/engine';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { HintCard } from '../hint/HintCard';
import { SessionTally } from '../hint/SessionTally';
import { JerkCheckCard } from '../jerk/JerkCheck';
import { JerkPicker } from '../jerk/JerkPicker';
import { Button } from '../ui/Button';
import { C } from '../ui/theme';
import { Felt } from './felt/Felt';
import type { HintMode, TableConfig } from './tableState';
import { useTable, type Table } from './useTable';

export function TableScreen({
  config,
  hintMode,
  onEndSession,
  onSettings,
}: {
  /** Fixed for the life of this component — see `useTable`. */
  readonly config: TableConfig;
  readonly hintMode: HintMode;
  /** Hands the report up rather than rendering it: the report card is a screen. */
  readonly onEndSession: (report: SessionReport) => void;
  readonly onSettings: () => void;
}) {
  const table = useTable(config, hintMode);
  const { felt } = table;

  return (
    <View style={styles.screen}>
      <View style={styles.rail}>
        <Pressable accessibilityRole="button" onPress={onSettings} hitSlop={8}>
          <Text style={styles.railLink}>Settings</Text>
        </Pressable>
        <Text style={styles.shoe} numberOfLines={1}>
          Round {felt.roundNumber}
          {felt.shufflePending ? ' · cut card' : ''}
        </Text>
        {/* The only way to the report card, so it says what it produces rather
            than "Quit". Ending is not destructive — the report is the point of
            having played. */}
        <Pressable
          accessibilityRole="button"
          onPress={() => onEndSession(table.report)}
          hitSlop={8}
        >
          <Text style={styles.railLink}>End session</Text>
        </Pressable>
      </View>

      <SessionTally report={table.report} />

      <Felt
        felt={felt}
        rules={table.rules}
        playerSeat={table.playerSeat}
        jerkSeat={table.jerk?.seat ?? null}
      />

      {/* SPEC §6, and unlike the toggle this replaced it changes nothing that
          is already dealt — so it genuinely belongs on the table. */}
      <JerkPicker
        botSeats={table.botSeats}
        jerk={table.jerk}
        seatCount={felt.seats.length}
        onChange={table.setJerkSeat}
      />

      {/* SPEC §7 sits above the hint: it is about the round that just ended,
          and the hint is about the decision in front of the player. Nearest the
          buttons wins. */}
      {table.jerkCheck === null ? null : (
        <JerkCheckCard
          check={table.jerkCheck}
          tally={table.report.jerk}
          seatCount={felt.seats.length}
          onCheck={table.checkJerk}
          onDismiss={table.dismissJerkCheck}
        />
      )}
      {/* The hint sits directly above the buttons it is advice about (SPEC §5.5). */}
      {table.hint === null ? null : <HintCard hint={table.hint} />}
      <Controls table={table} />
    </View>
  );
}

// --- The action bar --------------------------------------------------------

function Controls({ table }: { readonly table: Table }) {
  const { prompt, caughtUp } = table;

  if (!caughtUp) {
    return (
      <View style={styles.controls}>
        <Text style={styles.prompt}>dealing…</Text>
        <Button label="Skip" onPress={table.skip} variant="secondary" />
      </View>
    );
  }

  switch (prompt.kind) {
    case 'bet':
      return (
        <View style={styles.controls}>
          <Text style={styles.prompt}>Your bet</Text>
          {[5, 25, 100].map((amount) => (
            <Button
              key={amount}
              label={`$${amount}`}
              disabled={amount < prompt.min || amount > prompt.max}
              onPress={() => table.placeBet(amount)}
            />
          ))}
          <Button label="Sit out" onPress={() => table.placeBet(0)} variant="secondary" />
        </View>
      );

    case 'insurance':
      return (
        <View style={styles.controls}>
          <Text style={styles.prompt}>Insurance ${prompt.stake.toFixed(2)}?</Text>
          <Button label="No" onPress={() => table.takeInsurance(false)} variant="secondary" />
          <Button label="Yes" onPress={() => table.takeInsurance(true)} />
          <HintButton table={table} />
        </View>
      );

    case 'action':
      return (
        <View style={styles.controls}>
          {prompt.view.legalActions.map((action: Action) => (
            <Button
              key={action}
              label={ACTION_LABELS[action]}
              onPress={() => table.takeAction(action)}
            />
          ))}
          <HintButton table={table} />
        </View>
      );
  }
}

/** `on-request` (SPEC §5.5). Renders nothing in the other three modes. */
function HintButton({ table }: { readonly table: Table }) {
  if (!table.hintAvailable) return null;
  return <Button label="Hint?" onPress={table.askForHint} variant="secondary" />;
}

const ACTION_LABELS: Record<Action, string> = {
  hit: 'Hit',
  stand: 'Stand',
  double: 'Double',
  split: 'Split',
  surrender: 'Surrender',
};

// --- Styles ----------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.well },
  /** The rail is laid out, not floated: it is the one strip that never scrolls. */
  rail: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingTop: 52,
    paddingBottom: 10,
    paddingHorizontal: 16,
    backgroundColor: C.well,
  },
  railLink: { color: C.accent, fontSize: 12, fontWeight: '600' },
  shoe: { color: C.textFaint, fontSize: 11, flexShrink: 1, textAlign: 'center' },
  /**
   * The action bar is laid out beneath the felt rather than floated over it, so
   * the felt's height is what is left rather than what was guessed. `flexShrink`
   * is off: the buttons are the last thing that may be squeezed.
   */
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    paddingBottom: 28,
    backgroundColor: C.well,
    flexShrink: 0,
  },
  prompt: { color: C.textFaint, fontSize: 13, marginRight: 4 },
});
