/**
 * The third-base myth demo (SPEC §7).
 *
 * Nearly every casual player believes a bad player at third base hurts the
 * whole table. The engine can prove otherwise for the exact round just played,
 * because the shoe is deterministic given a seed and a draw index (M1 decision
 * 1) — so this card shows what actually happened beside what would have
 * happened, and keeps the running count.
 *
 * **Every sentence here is app-written and therefore inherits nothing.**
 * `explain.ts` decision 15's rule — no sentence in the app is capable of lying —
 * is enforced in the engine's templates by construction; this file has to earn
 * it line by line. The three that took work:
 *
 * - "Same result either way" for `unchanged`, **not** "their play didn't change
 *   your cards". `unchanged` is an equality of *money*. The player may well have
 *   been dealt entirely different cards and landed on the same net, which is a
 *   more interesting truth than the one the shorter sentence would tell.
 * - The verdict is stated as the counterfactual, never as blame. "Playing
 *   correctly would have left you $6 better off" is what `delta` measures;
 *   "they cost you $6" is a claim about intent the number does not support.
 * - The lesson line appears only once there are rounds behind it, because on a
 *   sample of one it would be a prediction rather than a report.
 */

import type { Counterfactual, JerkTally } from '@bj/engine';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { seatName } from '../table/felt/seatArc';
import type { JerkCheck as Check } from '../table/tableState';
import { formatMoney } from '../ui/money';

export function JerkCheckCard({
  check,
  tally,
  seatCount,
  onCheck,
  onDismiss,
}: {
  readonly check: Check;
  readonly tally: JerkTally;
  /** For naming the seat. See `seatName` — this card was the third place the
   *  app numbered a chair, and the only one doing it from zero. */
  readonly seatCount: number;
  readonly onCheck: () => void;
  readonly onDismiss: () => void;
}) {
  if (!check.revealed) {
    return (
      <View style={styles.card}>
        {/* SPEC §7's words, kept verbatim: the whole feature is a response to a
            feeling, and the sentence has to name the feeling. */}
        <Text style={styles.offer}>Feel like that cost you? Let&apos;s check.</Text>
        <View style={styles.row}>
          <Pressable style={styles.primary} onPress={onCheck}>
            <Text style={styles.primaryText}>Let&apos;s check</Text>
          </Pressable>
          <Pressable style={styles.ghost} onPress={onDismiss}>
            <Text style={styles.ghostText}>No thanks</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const { result, policy } = check;

  return (
    <View style={styles.card}>
      {/* `seatName`, not `Seat ${n}`: this printed the raw engine index, so the
          card said "Seat 6" for the chair the picker and the felt both called
          seat 7 — and for the one seat SPEC §7 is actually an argument about it
          now says "Third base", which is the name the argument is conducted in. */}
      <Text style={styles.who}>
        {seatName(result.correctedSeat, seatCount, false)} · {policy.label}
      </Text>
      <Text style={styles.habit}>{policy.description}</Text>

      <View style={styles.compare}>
        <Outcome label="What happened" net={result.actual.net} />
        <Outcome label="If they'd played the book" net={result.corrected.net} />
      </View>

      <Text style={styles.verdict}>{verdictLine(result)}</Text>

      <Text style={styles.tally}>
        This session · helped {tally.helped} · hurt {tally.hurt} · no change {tally.unchanged}
      </Text>
      {tally.helped + tally.hurt > 0 ? (
        <Text style={styles.lesson}>{netLine(tally)}</Text>
      ) : null}

      <Pressable style={styles.ghost} onPress={onDismiss}>
        <Text style={styles.ghostText}>Close</Text>
      </Pressable>
    </View>
  );
}

function Outcome({ label, net }: { readonly label: string; readonly net: number }) {
  return (
    <View style={styles.outcome}>
      <Text style={styles.outcomeLabel}>{label}</Text>
      <Text style={[styles.outcomeValue, net < 0 ? styles.bad : net > 0 ? styles.good : null]}>
        {formatMoney(net)}
      </Text>
    </View>
  );
}

/**
 * `delta` is `corrected − actual` (replay.ts decision 29), so a positive delta
 * means playing correctly would have paid more — i.e. the bad play hurt. The
 * sign is trivial to invert and the bug would be invisible: the counts would
 * still converge on even, with the labels swapped. `verdict` is read rather
 * than re-derived here precisely so this file cannot be the place it flips.
 */
function verdictLine(result: Counterfactual): string {
  const amount = formatMoney(Math.abs(result.delta));
  switch (result.verdict) {
    case 'unchanged':
      return 'Same result either way. Their play made no difference to what you were paid.';
    case 'hurt':
      return `This time it went against you: playing the book, that seat would have left you ${amount} better off.`;
    case 'helped':
      return `This time it went your way: playing the book, that seat would have left you ${amount} worse off.`;
  }
}

/**
 * Positive `netDelta` means correct play would have paid the player more across
 * the session, i.e. the bad player is down money on balance — so the sign is
 * flipped once, here, and the label says whose money it is.
 */
function netLine(tally: JerkTally): string {
  const effect = -tally.netDelta;
  if (effect === 0) return 'Net effect on your money so far: exactly nothing.';
  return `Net effect on your money so far: ${formatMoney(effect)}.`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#123b52',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2d6a8f',
    padding: 12,
    gap: 8,
  },
  offer: { color: '#cfe8f7', fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  who: { color: '#f2f7f4', fontSize: 13, fontWeight: '700' },
  habit: { color: '#8fbcd8', fontSize: 12 },
  compare: { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  outcome: { flex: 1, gap: 2 },
  outcomeLabel: { color: '#8fbcd8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  outcomeValue: { color: '#f2f7f4', fontSize: 16, fontWeight: '700' },
  good: { color: '#6fbf8b' },
  bad: { color: '#e08b6f' },
  verdict: { color: '#e6f2fa', fontSize: 13, lineHeight: 18 },
  tally: { color: '#8fbcd8', fontSize: 12 },
  lesson: { color: '#8fbcd8', fontSize: 12 },
  primary: {
    backgroundColor: '#e8c56a',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  primaryText: { color: '#1a1a1a', fontWeight: '700', fontSize: 13 },
  ghost: {
    borderWidth: 1,
    borderColor: '#2d6a8f',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
  },
  ghostText: { color: '#8fbcd8', fontSize: 13 },
});
