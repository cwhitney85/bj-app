/**
 * The session report card (SPEC §9).
 *
 * Every field `sessionReport` returns is rendered here, and nothing is computed
 * here. That is the whole point of the screen: `report.ts` has been returning
 * `biggestWin`, `biggestLoss` and a ranked `mistakes` list since it was written,
 * and `SessionTally` — the four-stat strip on the felt — showed none of them.
 * The numbers were correct and unreachable.
 *
 * The ordering is an argument, not a layout. Money first, because that is what
 * the player thinks the session was about; then how much of that they *chose*,
 * because that is what the app is actually teaching; then the mistakes that
 * explain the choosing; then, if Jerk Mode was on, the answer to SPEC §7.
 */

import type { JerkTally, SessionReport } from '@bj/engine';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../ui/Button';
import { C } from '../ui/theme';
import { LESSON } from './lessons';
import { formatMoney, formatSignedMoney } from '../ui/money';

export function SessionReportScreen({
  report,
  onPlayAgain,
  onHome,
}: {
  readonly report: SessionReport;
  readonly onPlayAgain: () => void;
  readonly onHome: () => void;
}) {
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Session report</Text>

        <Section title="The money">
          <Row label="Rounds played" value={`${report.roundsPlayed}`} />
          <Row label="Hands settled" value={`${report.handsPlayed}`} />
          <Row label="Net" value={signed(report.net)} tone={moneyTone(report.net)} />
          <Row label="Biggest win" value={signed(report.biggestWin)} />
          {/* `biggestLoss` is signed, never a magnitude (report.ts), so it needs
              no minus sign added and must not have one added twice. */}
          <Row label="Biggest loss" value={signed(report.biggestLoss)} />
        </Section>

        <Section title="The lesson">
          <Row label="Decisions coached" value={`${report.decisionsMade}`} />
          <Row label="Followed the book" value={accuracyText(report)} />
          {/* SPEC §9's headline number. "Est." is load-bearing: this is a sum of
              expected values, not of money that changed hands. Not clamped at
              zero — a deviation genuinely gains in the composition-dependent
              cells, and reporting a larger loss than was taken is the same lie
              as reporting a smaller one (report.ts decision 46). */}
          <Row
            label="Est. EV lost to deviations"
            value={money(report.evLost)}
            tone={report.evLost > 0 ? 'bad' : undefined}
            emphasis
          />
        </Section>

        <Mistakes report={report} />
        <Jerk tally={report.jerk} />
      </ScrollView>

      <View style={styles.actions}>
        <Button label="Home" onPress={onHome} variant="secondary" style={styles.action} />
        <Button label="Play again" onPress={onPlayAgain} style={styles.action} />
      </View>
    </View>
  );
}

/**
 * SPEC §9's "most frequent mistakes, ranked" — ranked by money, which is the
 * order `rankMistakes` returns and the order the number above it argues for.
 * `count` is shown alongside so the other reading is available without the
 * screen re-sorting anything.
 */
function Mistakes({ report }: { readonly report: SessionReport }) {
  if (report.mistakes.length === 0) {
    return (
      <Section title="What it cost you">
        <Text style={styles.empty}>
          {report.decisionsMade === 0
            ? 'No decisions yet — the report fills in as you play.'
            : 'Every decision followed the book. Nothing to rank.'}
        </Text>
      </Section>
    );
  }

  return (
    <Section title="What it cost you" subtitle="Ranked by money given up, not by how often">
      {report.mistakes.map((mistake) => (
        <View key={mistake.reasonCode} style={styles.mistake}>
          <View style={styles.mistakeText}>
            <Text style={styles.mistakeLesson}>{LESSON[mistake.reasonCode]}</Text>
            <Text style={styles.mistakeCount}>
              {mistake.count === 1 ? '1 deviation' : `${mistake.count} deviations`}
            </Text>
          </View>
          <Text style={[styles.value, mistake.evLost > 0 && styles.bad]}>
            {money(mistake.evLost)}
          </Text>
        </View>
      ))}
    </Section>
  );
}

/**
 * SPEC §7's answer, for the session that just ended.
 *
 * Rendered only when the tally has something in it. An all-zero tally means
 * either Jerk Mode was off or no round completed, and a section reading
 * "helped 0, hurt 0" invites the player to conclude something from a sample of
 * none — which is the opposite of the point the feature exists to make.
 */
function Jerk({ tally }: { readonly tally: JerkTally }) {
  const checked = tally.helped + tally.hurt + tally.unchanged;
  if (checked === 0) return null;

  return (
    <Section
      title="The player at the bad seat"
      subtitle="Every round replayed with that seat playing correctly"
    >
      <Row label="Their bad play helped you" value={`${tally.helped}`} />
      <Row label="Their bad play hurt you" value={`${tally.hurt}`} />
      <Row label="Changed nothing" value={`${tally.unchanged}`} />
      {/* Positive `netDelta` means the jerk cost you money on balance
          (replay.ts), so the sign is inverted to read as a result. */}
      <Row
        label="On balance"
        value={signed(0 - tally.netDelta)}
        tone={moneyTone(0 - tally.netDelta)}
      />
      <Text style={styles.note}>
        {verdict(tally)} Over a long enough session this lands near even — a bad
        player is as likely to help you as to hurt you.
      </Text>
    </Section>
  );
}

function verdict(tally: JerkTally): string {
  if (tally.helped > tally.hurt) return 'They helped you more often than they hurt you.';
  if (tally.hurt > tally.helped) return 'They hurt you more often than they helped you.';
  return 'They helped you exactly as often as they hurt you.';
}

// --- Layout ----------------------------------------------------------------

function Section({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle === undefined ? null : <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({
  label,
  value,
  tone,
  emphasis,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'good' | 'bad';
  readonly emphasis?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, emphasis === true && styles.rowLabelEmphasis]}>{label}</Text>
      <Text
        style={[
          styles.value,
          emphasis === true && styles.valueEmphasis,
          tone === 'good' && styles.good,
          tone === 'bad' && styles.bad,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

// --- Formatting ------------------------------------------------------------

/** Signed, for figures whose direction is the information. */
function signed(amount: number): string {
  return formatSignedMoney(amount);
}

/** Unsigned, for figures that are already named as a cost. */
function money(amount: number): string {
  return formatMoney(amount);
}

function moneyTone(amount: number): 'good' | 'bad' | undefined {
  if (amount > 0) return 'good';
  if (amount < 0) return 'bad';
  return undefined;
}

/**
 * `null` accuracy is rendered, not defaulted (report.ts decision 47): a player
 * who has not acted has not been perfect, and "100%" is a sentence this app
 * cannot defend.
 */
function accuracyText(report: SessionReport): string {
  if (report.accuracy === null) return '—';
  const followed = report.decisionsMade - report.deviations;
  return `${Math.round(report.accuracy * 100)}%  (${followed}/${report.decisionsMade})`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.felt },
  body: { padding: 20, paddingTop: 64, paddingBottom: 32, gap: 20 },
  title: { color: C.text, fontSize: 26, fontWeight: '700' },

  section: { gap: 4 },
  sectionTitle: {
    color: C.accent,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sectionSubtitle: { color: C.textFaintest, fontSize: 11 },
  sectionBody: {
    backgroundColor: C.wellSoft,
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginTop: 4,
  },

  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  rowLabel: { color: C.textDim, fontSize: 13, flexShrink: 1 },
  rowLabelEmphasis: { color: C.text, fontWeight: '600' },
  value: { color: C.text, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  valueEmphasis: { fontSize: 17 },
  good: { color: C.good },
  bad: { color: C.bad },

  mistake: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
  },
  mistakeText: { flexShrink: 1, gap: 2 },
  mistakeLesson: { color: C.text, fontSize: 13 },
  mistakeCount: { color: C.textFaintest, fontSize: 11 },

  empty: { color: C.textFaint, fontSize: 13, paddingVertical: 10 },
  note: { color: C.textFaint, fontSize: 12, lineHeight: 17, paddingVertical: 10 },

  actions: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    paddingBottom: 28,
    backgroundColor: C.well,
  },
  action: { flex: 1 },
});
