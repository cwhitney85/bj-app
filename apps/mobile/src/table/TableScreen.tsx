/**
 * The table (SPEC §9).
 *
 * Everything here is drawn from the `ShownTable` the hook folds out of the event
 * stream. The 2.5D felt, the seat arc and real card faces are still ahead; this
 * is the layout in its honest first form, so that what is on screen is provably
 * what the engine narrated.
 *
 * **What this screen no longer owns.** It used to carry the hint-mode picker and
 * the Jerk Mode toggle as felt furniture. Both belonged elsewhere and said so:
 * hint mode is a setting (SPEC §5.5) and Jerk Mode is a seating decision fixed
 * before a card is dealt (SPEC §9's seat select), which the toggle honoured by
 * re-dealing the table underneath the player and discarding the session. They
 * are props and a `SeatDraft` now. What is left is the felt, the coaching that
 * belongs directly above the action buttons, and a rail that leaves.
 */

import type { Action, Card, SessionReport, ShownCard, ShownDealer, ShownHand, ShownSeat } from '@bj/engine';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HintCard } from '../hint/HintCard';
import { SessionTally } from '../hint/SessionTally';
import { JerkCheckCard } from '../jerk/JerkCheck';
import { JerkPicker } from '../jerk/JerkPicker';
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
        <Text style={styles.shoe}>
          Round {felt.roundNumber} · shoe {felt.shoeIndex}
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

      <ScrollView contentContainerStyle={styles.felt}>
        <SessionTally report={table.report} />

        <Text style={styles.phase}>{felt.phase}</Text>

        <Dealer dealer={felt.dealer} />

        <View style={styles.seats}>
          {felt.seats
            .filter((seat) => seat.occupant.kind !== 'empty')
            .map((seat) => (
              <SeatCard
                key={seat.index}
                seat={seat}
                isPlayer={seat.index === table.playerSeat}
                isActing={seat.index === felt.turnSeat}
              />
            ))}
        </View>

        {/* SPEC §6, and unlike the toggle this replaced it changes nothing that
            is already dealt — so it genuinely belongs on the table. */}
        <JerkPicker botSeats={table.botSeats} jerk={table.jerk} onChange={table.setJerkSeat} />
      </ScrollView>

      {/* SPEC §7 sits above the hint: it is about the round that just ended,
          and the hint is about the decision in front of the player. Nearest the
          buttons wins. */}
      {table.jerkCheck === null ? null : (
        <JerkCheckCard
          check={table.jerkCheck}
          tally={table.report.jerk}
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

// --- The felt --------------------------------------------------------------

function Dealer({ dealer }: { readonly dealer: ShownDealer }) {
  return (
    <View style={styles.dealer}>
      <Text style={styles.label}>Dealer</Text>
      <View style={styles.cards}>
        {dealer.cards.map((card, index) => (
          <FaceCard key={index} shown={card} />
        ))}
      </View>
      <Text style={styles.total}>
        {dealer.busted ? 'bust' : formatTotal(dealer.total, dealer.soft)}
      </Text>
    </View>
  );
}

function SeatCard({
  seat,
  isPlayer,
  isActing,
}: {
  readonly seat: ShownSeat;
  readonly isPlayer: boolean;
  readonly isActing: boolean;
}) {
  return (
    <View style={[styles.seat, isPlayer && styles.playerSeat, isActing && styles.actingSeat]}>
      <Text style={styles.label}>
        {isPlayer ? 'You' : `Seat ${seat.index}`} · ${seat.bankroll.toFixed(2)}
        {seat.insuranceBet > 0 ? ` · ins $${seat.insuranceBet.toFixed(2)}` : ''}
      </Text>
      {seat.hands.length === 0 ? (
        <Text style={styles.total}>{seat.baseBet > 0 ? `$${seat.baseBet}` : 'sitting out'}</Text>
      ) : (
        seat.hands.map((hand, index) => (
          <HandRow key={index} hand={hand} isActing={isActing && seat.activeHandIndex === index} />
        ))
      )}
    </View>
  );
}

function HandRow({ hand, isActing }: { readonly hand: ShownHand; readonly isActing: boolean }) {
  return (
    <View style={[styles.hand, isActing && styles.actingHand]}>
      <View style={styles.cards}>
        {hand.cards.map((card) => (
          <FaceCard key={card.id} shown={{ facing: 'up', card }} />
        ))}
      </View>
      <Text style={styles.total}>
        {handStatus(hand)}
        {hand.bet > 0 ? `  $${hand.bet}` : ''}
        {hand.net === null ? '' : `  ${hand.net >= 0 ? '+' : '-'}$${Math.abs(hand.net).toFixed(2)}`}
      </Text>
    </View>
  );
}

function FaceCard({ shown }: { readonly shown: ShownCard }) {
  if (shown.facing === 'down') {
    return (
      <View style={[styles.card, styles.cardBack]}>
        <Text style={styles.cardBackPip}>◆</Text>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <Text style={[styles.cardText, isRed(shown.card) && styles.red]}>
        {shown.card.rank}
        {suitPip(shown.card.suit)}
      </Text>
    </View>
  );
}

// --- The action bar --------------------------------------------------------

function Controls({ table }: { readonly table: Table }) {
  const { prompt, caughtUp } = table;

  if (!caughtUp) {
    return (
      <View style={styles.controls}>
        <Text style={styles.dealing}>dealing…</Text>
        <Button label="Skip" onPress={table.skip} />
      </View>
    );
  }

  switch (prompt.kind) {
    case 'bet':
      return (
        <View style={styles.controls}>
          <Text style={styles.dealing}>Your bet</Text>
          {[5, 25, 100].map((amount) => (
            <Button
              key={amount}
              label={`$${amount}`}
              disabled={amount < prompt.min || amount > prompt.max}
              onPress={() => table.placeBet(amount)}
            />
          ))}
          <Button label="Sit out" onPress={() => table.placeBet(0)} />
        </View>
      );

    case 'insurance':
      return (
        <View style={styles.controls}>
          <Text style={styles.dealing}>Insurance ${prompt.stake.toFixed(2)}?</Text>
          <Button label="No" onPress={() => table.takeInsurance(false)} />
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
  return <Button label="Hint?" onPress={table.askForHint} secondary />;
}

function Button({
  label,
  onPress,
  disabled,
  secondary,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly secondary?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.button,
        secondary === true && styles.buttonSecondary,
        disabled === true && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled === true}
    >
      <Text style={[styles.buttonText, secondary === true && styles.buttonSecondaryText]}>
        {label}
      </Text>
    </Pressable>
  );
}

// --- Formatting ------------------------------------------------------------

const ACTION_LABELS: Record<Action, string> = {
  hit: 'Hit',
  stand: 'Stand',
  double: 'Double',
  split: 'Split',
  surrender: 'Surrender',
};

/** `null` is a split hand still waiting for its second card — a real table shows no badge. */
function formatTotal(total: number | null, soft: boolean): string {
  if (total === null) return '';
  return soft ? `soft ${total}` : `${total}`;
}

function handStatus(hand: ShownHand): string {
  if (hand.busted) return 'bust';
  if (hand.surrendered) return 'surrendered';
  const total = formatTotal(hand.total, hand.soft);
  if (hand.doubled) return `${total} (doubled)`;
  return hand.standing ? `${total} ✓` : total;
}

function isRed(card: Card): boolean {
  return card.suit === 'H' || card.suit === 'D';
}

function suitPip(suit: Card['suit']): string {
  return { S: '♠', H: '♥', D: '♦', C: '♣' }[suit];
}

// --- Styles ----------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b3d2e' },
  /** The rail is laid out, not floated: it is the one strip that never scrolls. */
  rail: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingTop: 52,
    paddingBottom: 10,
    paddingHorizontal: 16,
    backgroundColor: '#08281e',
  },
  railLink: { color: '#e8c56a', fontSize: 12, fontWeight: '600' },
  /** `paddingBottom` clears the action bar, which floats over the felt. */
  felt: { padding: 16, paddingTop: 16, paddingBottom: 96, gap: 16 },
  shoe: { color: '#8fbfa8', fontSize: 11, flexShrink: 1, textAlign: 'center' },
  phase: { color: '#8fbfa8', fontSize: 12, textAlign: 'center' },
  dealer: { alignItems: 'center', gap: 6, paddingVertical: 12 },
  seats: { gap: 10 },
  seat: {
    backgroundColor: '#0e4a37',
    borderRadius: 10,
    padding: 10,
    gap: 6,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  playerSeat: { backgroundColor: '#12563f' },
  actingSeat: { borderColor: '#e8c56a' },
  hand: { gap: 4, paddingVertical: 2 },
  actingHand: { borderLeftWidth: 3, borderLeftColor: '#e8c56a', paddingLeft: 8 },
  cards: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  card: {
    width: 34,
    height: 48,
    borderRadius: 4,
    backgroundColor: '#fdfdf7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBack: { backgroundColor: '#7a2230' },
  cardBackPip: { color: '#d8a0aa', fontSize: 16 },
  cardText: { fontSize: 13, fontWeight: '600', color: '#1a1a1a' },
  red: { color: '#c0293b' },
  label: { color: '#cfe8dc', fontSize: 12, fontWeight: '600' },
  total: { color: '#f2f7f4', fontSize: 13 },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    paddingBottom: 28,
    backgroundColor: '#08281e',
  },
  dealing: { color: '#8fbfa8', fontSize: 13, marginRight: 4 },
  button: {
    backgroundColor: '#e8c56a',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  buttonDisabled: { opacity: 0.35 },
  buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#e8c56a' },
  buttonText: { color: '#1a1a1a', fontWeight: '700', fontSize: 14 },
  buttonSecondaryText: { color: '#e8c56a' },
});
