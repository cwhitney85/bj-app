/**
 * The table (SPEC §9).
 *
 * Everything here is drawn from the `ShownTable` the hook folds out of the event
 * stream. The 2.5D felt, the seat arc and real card faces are still ahead; this
 * is the layout in its honest first form, so that what is on screen is provably
 * what the engine narrated.
 */

import type { Action, Card, ShownCard, ShownDealer, ShownHand, ShownSeat } from '@bj/engine';
import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTable } from './useTable';

const SEED = 20260812;

export function TableScreen() {
  const table = useTable(SEED);
  const { felt } = table;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.felt}>
        <Text style={styles.shoe}>
          Round {felt.roundNumber} · {felt.phase} · shoe {felt.shoeIndex}
          {felt.shufflePending ? ' · cut card reached' : ''}
        </Text>

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
      </ScrollView>

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

function Controls({ table }: { readonly table: ReturnType<typeof useTable> }) {
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
              onPress={() => table.bet(amount)}
            />
          ))}
          <Button label="Sit out" onPress={() => table.bet(0)} />
        </View>
      );

    case 'insurance':
      return (
        <View style={styles.controls}>
          <Text style={styles.dealing}>Insurance ${prompt.stake.toFixed(2)}?</Text>
          <Button label="No" onPress={() => table.insure(false)} />
          <Button label="Yes" onPress={() => table.insure(true)} />
        </View>
      );

    case 'action':
      return (
        <View style={styles.controls}>
          {prompt.view.legalActions.map((action: Action) => (
            <Button key={action} label={ACTION_LABELS[action]} onPress={() => table.act(action)} />
          ))}
        </View>
      );
  }
}

function Button({
  label,
  onPress,
  disabled,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.button, disabled === true && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled === true}
    >
      <Text style={styles.buttonText}>{label}</Text>
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
  /** `paddingBottom` clears the action bar, which floats over the felt. */
  felt: { padding: 16, paddingTop: 56, paddingBottom: 96, gap: 16 },
  shoe: { color: '#8fbfa8', fontSize: 12, textAlign: 'center' },
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
  buttonText: { color: '#1a1a1a', fontWeight: '700', fontSize: 14 },
});
