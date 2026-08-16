/**
 * Seat select (SPEC §9): "pick a seat, choose how many bots (0–6)."
 *
 * Two phases, in the order the table is actually laid out: take a chair, then
 * fill the ones you want occupied, then deal. The chart is the control — tap a
 * chair, it changes — because a seat picker that is not shaped like a table
 * hides the one thing this screen exists to let the player decide.
 *
 * **Seat order is not cosmetic (SPEC §4).** It decides who acts before and after
 * the player, which is the premise of the third-base demo, so the screen names
 * first base and third base rather than leaving the player to infer them from
 * the numbering.
 *
 * **Who plays badly is not chosen here.** That was a setup question while the
 * assignment was fixed at deal; it is now a table control the player can move or
 * clear at any moment (`setJerk`), so it lives on the felt. A table still deals
 * with one bad player already seated — see `configFrom`.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../ui/Button';
import { C } from '../ui/theme';
import {
  canDeal,
  EMPTY_DRAFT,
  SEAT_COUNT,
  sitAt,
  standUp,
  toggleBot,
  type SeatDraft,
} from './seatDraft';

export function SeatSelectScreen({
  onDeal,
  onBack,
}: {
  readonly onDeal: (draft: SeatDraft) => void;
  readonly onBack: () => void;
}) {
  const [draft, setDraft] = useState<SeatDraft>(EMPTY_DRAFT);
  const seated = canDeal(draft);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>{seated ? 'Fill the table' : 'Take a seat'}</Text>
        <Text style={styles.lede}>
          {seated
            ? 'Tap any empty chair to seat another player, or tap it again to clear it. They play perfect basic strategy — the same advice you are being given.'
            : 'Tap a chair. Seat 1 acts first; seat 7 is third base and acts last, just before the dealer.'}
        </Text>

        <View style={styles.table}>
          <Text style={styles.dealer}>dealer</Text>
          <View style={styles.chart}>
            {Array.from({ length: SEAT_COUNT }, (_, index) => (
              <SeatChip
                key={index}
                index={index}
                state={
                  index === draft.playerSeat
                    ? 'player'
                    : draft.botSeats.includes(index)
                      ? 'bot'
                      : 'empty'
                }
                onPress={() =>
                  setDraft(
                    index === draft.playerSeat
                      ? standUp(draft)
                      : !seated
                        ? sitAt(draft, index)
                        : toggleBot(draft, index),
                  )
                }
              />
            ))}
          </View>
          <View style={styles.ends}>
            <Text style={styles.end}>first base</Text>
            <Text style={styles.end}>third base</Text>
          </View>
        </View>

        {seated ? (
          <Field label="Your table">
            <Text style={styles.summary}>
              You are in seat {(draft.playerSeat ?? 0) + 1}
              {describeNeighbours(draft)}.
            </Text>
            <Text style={styles.hint}>
              Tap your own chair to move seats. One of the other players will be
              given a realistic bad habit — you can move it to whichever seat you
              like, or switch it off, once the cards are out.
            </Text>
          </Field>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Button label="Back" onPress={onBack} variant="secondary" style={styles.back} />
        <Button
          label="Start game"
          disabled={!seated}
          onPress={() => onDeal(draft)}
          style={styles.deal}
        />
      </View>
    </View>
  );
}

/**
 * Say who acts around the player, because that is the fact seat order carries
 * and the seat *number* does not communicate on its own.
 */
function describeNeighbours(draft: SeatDraft): string {
  const seat = draft.playerSeat;
  if (seat === null) return '';
  const before = draft.botSeats.filter((index) => index < seat).length;
  const after = draft.botSeats.filter((index) => index > seat).length;
  if (before === 0 && after === 0) return ', alone at the table';
  if (after === 0) return `, acting after ${count(before)} and last before the dealer`;
  if (before === 0) return `, acting first, with ${count(after)} behind you`;
  return `, acting after ${count(before)} and before ${count(after)}`;
}

function count(n: number): string {
  return n === 1 ? 'one player' : `${n} players`;
}

function SeatChip({
  index,
  state,
  onPress,
}: {
  readonly index: number;
  readonly state: 'player' | 'bot' | 'empty';
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: state !== 'empty' }}
      accessibilityLabel={`Seat ${index + 1}, ${state === 'player' ? 'you' : state}`}
      onPress={onPress}
      style={[styles.seat, state === 'bot' && styles.seatBot, state === 'player' && styles.seatYou]}
    >
      <Text style={[styles.seatNumber, state === 'player' && styles.seatNumberYou]}>
        {index + 1}
      </Text>
      <Text style={[styles.seatWho, state === 'player' && styles.seatWhoYou]}>
        {state === 'player' ? 'you' : state === 'bot' ? '●' : ''}
      </Text>
    </Pressable>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.felt },
  body: { padding: 20, paddingTop: 64, paddingBottom: 32, gap: 22 },
  title: { color: C.text, fontSize: 26, fontWeight: '700' },
  lede: { color: C.textDim, fontSize: 14, lineHeight: 20, marginTop: -12 },

  table: { gap: 6 },
  dealer: {
    color: C.textFaintest,
    fontSize: 10,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  chart: { flexDirection: 'row', gap: 5, justifyContent: 'space-between' },
  ends: { flexDirection: 'row', justifyContent: 'space-between' },
  end: { color: C.textFaintest, fontSize: 9 },
  seat: {
    flex: 1,
    aspectRatio: 0.8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.edge,
    backgroundColor: C.panel,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  seatBot: { backgroundColor: C.panelPlayer, borderColor: C.textFaintest },
  seatYou: { backgroundColor: C.accent, borderColor: C.accent },
  seatNumber: { color: C.textFaint, fontSize: 14, fontWeight: '700' },
  seatNumberYou: { color: C.onAccent },
  seatWho: { color: C.textFaint, fontSize: 9, height: 11 },
  seatWhoYou: { color: C.onAccent, fontWeight: '700' },

  field: { gap: 8 },
  fieldLabel: {
    color: C.accent,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  summary: { color: C.text, fontSize: 14, lineHeight: 20 },
  hint: { color: C.textFaintest, fontSize: 12, lineHeight: 17 },

  actions: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    paddingBottom: 28,
    backgroundColor: C.well,
  },
  back: { flex: 1 },
  deal: { flex: 2 },
});
