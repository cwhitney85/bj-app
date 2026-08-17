/**
 * The report card, live (SPEC §9).
 *
 * The full post-session screen is still ahead; this is the two numbers that
 * make the lesson concrete while it is being learned — basic-strategy accuracy,
 * and estimated EV lost to deviations in dollars. Both come straight off
 * `sessionReport`; nothing is computed here.
 *
 * `accuracy` is `number | null` and the null is rendered rather than defaulted
 * (report.ts decision 47): telling a player who has not yet acted that they are
 * 100% accurate is a sentence this app cannot defend.
 */

import type { SessionReport } from '@bj/engine';
import { StyleSheet, Text, View } from 'react-native';
import { formatExpectation, formatSignedMoney } from '../ui/money';

export function SessionTally({ report }: { readonly report: SessionReport }) {
  return (
    <View style={styles.strip}>
      <Stat label="Rounds" value={`${report.roundsPlayed}`} />
      <Stat label="Net" value={signedMoney(report.net)} tone={tone(report.net)} />
      <Stat
        label="Book play"
        value={report.accuracy === null ? '—' : `${Math.round(report.accuracy * 100)}%`}
      />
      {/* Positive `evLost` means money given up. It is not clamped at zero:
          a deviation can genuinely gain in the composition-dependent cells,
          and reporting a larger loss than was taken is the same lie as
          reporting a smaller one (report.ts decision 46). */}
      {/* "Est." is load-bearing: SPEC §9 asks for *estimated* EV lost, and this
          is a sum of expected values, not of money that changed hands. */}
      <Stat
        label="Est. EV lost"
        value={formatExpectation(report.evLost)}
        tone={report.evLost > 0 ? 'bad' : undefined}
      />
    </View>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'good' | 'bad';
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, tone === 'good' && styles.good, tone === 'bad' && styles.bad]}>
        {value}
      </Text>
    </View>
  );
}

function signedMoney(net: number): string {
  return formatSignedMoney(net);
}

function tone(net: number): 'good' | 'bad' | undefined {
  if (net > 0) return 'good';
  if (net < 0) return 'bad';
  return undefined;
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#0a2b23',
    borderRadius: 8,
  },
  stat: { gap: 2, alignItems: 'center', flex: 1 },
  label: { color: '#7ba894', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { color: '#f2f7f4', fontSize: 14, fontWeight: '700' },
  good: { color: '#6fbf8b' },
  bad: { color: '#e08b6f' },
});
