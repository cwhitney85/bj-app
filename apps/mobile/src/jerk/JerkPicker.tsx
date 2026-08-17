/**
 * Who is playing badly, right now (SPEC §6).
 *
 * A table control, not a setting and not a setup choice. The player hands the
 * bad habit to any occupied chair or takes it away, at any moment, and the table
 * carries on — no re-deal, no lost session, no card moved. That is only possible
 * because `Deciders` is an argument to the engine's transitions rather than
 * state inside them (M4 decision 33), and because the habit is derived from the
 * seat under its own label (`habitFor`), so choosing a different bad player
 * cannot consume the shuffle's stream.
 *
 * **This is on the felt on purpose, having just removed the old Jerk Mode
 * toggle from it.** The distinction is not cosmetics: the old toggle was a
 * *seating* decision, and seating is fixed before a card is dealt, so it
 * honoured its own contract by re-dealing the table and discarding the session.
 * This one changes nothing that is already dealt. A control that belongs to the
 * table now genuinely belongs to the table.
 *
 * The habit's name is shown because it is the whole content of the lesson: "seat
 * 5 hits every 16" is a claim the player can watch being tested, and "Jerk Mode:
 * on" is not.
 */

import { JERK_POLICIES, type JerkAssignment } from '@bj/engine';
import { StyleSheet, Text, View } from 'react-native';

import { seatName } from '../table/felt/seatArc';
import { Button } from '../ui/Button';
import { C } from '../ui/theme';

/** SPEC §6's habits, as a sentence about the seat playing them. */
const HABIT: Record<string, string> = {
  'always-insures': 'takes insurance every time',
  'hits-every-16': 'hits every 16',
  'never-splits': 'never splits anything',
  'stands-on-soft-17': 'stands on soft 17',
  'doubles-twelve': 'doubles 12 because it feels right',
  'mimics-dealer': 'mimics the dealer',
};

/**
 * `BotPolicy.id` is a `string`, so no `Record` over it can be checked for
 * totality by the compiler the way `lessons.ts` is over `ReasonCode`. Checked at
 * module load instead, which is the same device `CARD_NEUTRAL_JERK` uses: a
 * habit added to `bots.ts` without copy fails here, loudly and immediately,
 * rather than rendering its raw id as the sentence describing the bad player.
 */
const MISSING = JERK_POLICIES.filter((policy) => HABIT[policy.id] === undefined);
if (MISSING.length > 0) {
  throw new Error(`JerkPicker: no copy for habit(s) ${MISSING.map((p) => p.id).join(', ')}`);
}

export function JerkPicker({
  botSeats,
  jerk,
  seatCount,
  onChange,
}: {
  readonly botSeats: readonly number[];
  readonly jerk: JerkAssignment | null;
  /** For naming the seats. `seatName` is the app's one rule for that. */
  readonly seatCount: number;
  readonly onChange: (seat: number | null) => void;
}) {
  // Nobody to give the habit to. An empty picker would be a control that cannot
  // do anything, which is worse than no control.
  if (botSeats.length === 0) return null;

  return (
    <View style={styles.panel}>
      <Text style={styles.label}>The bad player</Text>
      <View style={styles.row}>
        <Button
          variant="pill"
          label="Nobody"
          selected={jerk === null}
          onPress={() => onChange(null)}
        />
        {botSeats.map((seat) => (
          <Button
            key={seat}
            variant="pill"
            /* `seatName` owns the 0-based-engine to 1-based-player translation,
               and names the two seats SPEC §7 argues about. Three files were
               numbering chairs independently and one of them was off by one. */
            label={seatName(seat, seatCount, false)}
            selected={jerk?.seat === seat}
            onPress={() => onChange(seat)}
          />
        ))}
      </View>
      <Text style={styles.caption}>
        {jerk === null
          ? 'Everyone is playing the book. Hand the habit to a seat to see what it costs you.'
          : `${seatName(jerk.seat, seatCount, false)} ${HABIT[jerk.policy.id]}. Every round is replayed with that seat playing correctly.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 7,
    padding: 12,
    borderRadius: 10,
    backgroundColor: C.wellSoft,
  },
  label: {
    color: C.accent,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  caption: { color: C.textFaintest, fontSize: 11, lineHeight: 16 },
});
