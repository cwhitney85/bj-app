/**
 * The hint card (SPEC §5.5).
 *
 * Collapsed it is the recommended action and one line of reason, sitting above
 * the action buttons. Tapping expands the full explanation and a horizontal EV
 * bar per legal action.
 *
 * Every word and every number on this card came from `@bj/engine`. Nothing here
 * decides what the advice is, rounds a probability, or writes a sentence —
 * `explain.ts` owns the prose precisely so that the app cannot say two different
 * things in two places, and `coach.ts` owns the chart-vs-EV resolution so that a
 * beginner is never shown a headline arguing with its own bars. This file
 * chooses colours and positions.
 *
 * The expansion is an inline panel rather than a modal sheet. It is the same
 * information in the same order, and it keeps the felt visible behind the
 * advice — which matters, because the advice is about the cards on it.
 */

import type { ActionEv, Coaching, Decision, Explanation } from '@bj/engine';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Hint, Reviewed } from '../table/tableState';
import { formatExpectation } from '../ui/money';

export function HintCard({ hint }: { readonly hint: Hint }) {
  const [expanded, setExpanded] = useState(false);

  const explanation = hint.kind === 'advice' ? explanationOf(hint.coaching) : explanationOf(hint.reviewed.coaching);

  return (
    <View style={[styles.card, hint.kind === 'verdict' && verdictStyle(hint.reviewed.decision)]}>
      <Pressable onPress={() => setExpanded((open) => !open)} style={styles.header}>
        <View style={styles.headerText}>
          {hint.kind === 'advice' ? (
            <AdviceHeadline explanation={explanation} />
          ) : (
            <VerdictHeadline reviewed={hint.reviewed} />
          )}
        </View>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded ? (
        <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetBody}>
          <Text style={styles.detail}>{explanation.detail}</Text>
          <EvBars coaching={hint.kind === 'advice' ? hint.coaching : hint.reviewed.coaching} />
          {explanation.advancedNote === null ? null : (
            <Text style={styles.advanced}>{explanation.advancedNote}</Text>
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

// --- Headlines -------------------------------------------------------------

function AdviceHeadline({ explanation }: { readonly explanation: Explanation }) {
  return (
    <>
      <Text style={styles.headline}>{explanation.headline}</Text>
      <Text style={styles.summary}>{explanation.summary}</Text>
    </>
  );
}

/**
 * "Play first, then see whether you were right" (SPEC §5.5).
 *
 * A deviation is never scolded (SPEC §5.5), so this states what the book said
 * and what the difference was worth, and stops. `moneyDelta` is chosen minus
 * recommended (coach.ts decision 42), so it is negative when the deviation cost
 * money — and it is allowed to be positive, in the composition-dependent cells
 * where the EV calculator genuinely disagrees with the chart. Rendering that
 * honestly is the same commitment `explain.ts` makes about its prose.
 */
function VerdictHeadline({ reviewed }: { readonly reviewed: Reviewed }) {
  const { decision, coaching } = reviewed;

  if (decision.wasRecommended) {
    return (
      <>
        <Text style={styles.headline}>Correct — that was the book play.</Text>
        <Text style={styles.summary}>{explanationOf(coaching).summary}</Text>
      </>
    );
  }

  return (
    <>
      <Text style={styles.headline}>
        The book said {bookAnswer(coaching)}. {signedMoney(decision.moneyDelta)}
      </Text>
      <Text style={styles.summary}>{explanationOf(coaching).summary}</Text>
    </>
  );
}

// --- EV bars ---------------------------------------------------------------

/**
 * One bar per legal action, in dollars per dollar wagered (SPEC §5.2).
 *
 * The bars share one scale so their lengths are comparable, and the scale is
 * the largest magnitude on screen rather than a constant: split EV is the value
 * of *both* hands and ranges over [−4, 4] (M2 decision 5), so a fixed [−1, 1]
 * axis would clip it, and a fixed [−4, 4] axis would render every ordinary
 * stand-versus-hit decision as two indistinguishable stubs.
 */
function EvBars({ coaching }: { readonly coaching: Coaching }) {
  if (coaching.kind === 'insurance') {
    return (
      <View style={styles.bars}>
        <EvBar label="Insurance" ev={coaching.ev} scale={1} recommended={false} />
        <EvBar label="Decline" ev={0} scale={1} recommended />
        <Text style={styles.footnote}>Per dollar of the insurance stake, not of your bet.</Text>
      </View>
    );
  }

  const rows = evRows(coaching.ev);
  const scale = Math.max(...rows.map((row) => Math.abs(row.ev)), 0.2);
  const note = coaching.explanation.approximationNote;

  return (
    <View style={styles.bars}>
      {rows.map((row) => (
        <EvBar
          key={row.label}
          label={row.label}
          ev={row.ev}
          scale={scale}
          recommended={row.action === coaching.recommendation.action}
        />
      ))}
      {/* SPEC §5.2 and M2 decisions 7 & 18: split EV is approximate, and must
          be labelled where it is shown. The engine supplies the wording. */}
      {note === null ? null : <Text style={styles.footnote}>{note}</Text>}
    </View>
  );
}

function EvBar({
  label,
  ev,
  scale,
  recommended,
}: {
  readonly label: string;
  readonly ev: number;
  readonly scale: number;
  readonly recommended: boolean;
}) {
  const fraction = Math.min(Math.abs(ev) / scale, 1);
  // A numeric percent, not `toFixed`: RN's `DimensionValue` accepts `${number}%`,
  // and a string from `toFixed` widens to `${string}%`, which it does not.
  const percent = Math.round(fraction * 500) / 10;
  const width = `${percent}%` as const;

  return (
    <View style={styles.barRow}>
      <Text style={[styles.barLabel, recommended && styles.barLabelBest]}>
        {recommended ? '★ ' : ''}
        {label}
      </Text>
      <View style={styles.barTrack}>
        <View style={styles.barZero} />
        <View
          style={[
            styles.barFill,
            ev >= 0 ? styles.barPositive : styles.barNegative,
            { width },
            ev >= 0 ? { left: '50%' } : { right: '50%' },
          ]}
        />
      </View>
      <Text style={styles.barValue}>{signedCents(ev)}</Text>
    </View>
  );
}

function evRows(ev: ActionEv): readonly {
  readonly label: string;
  readonly action: string;
  readonly ev: number;
}[] {
  const rows = [
    { label: 'Stand', action: 'stand', ev: ev.stand },
    { label: 'Hit', action: 'hit', ev: ev.hit },
  ];
  if (ev.double !== null) rows.push({ label: 'Double', action: 'double', ev: ev.double });
  if (ev.split !== null) rows.push({ label: 'Split', action: 'split', ev: ev.split });
  return rows;
}

// --- Formatting ------------------------------------------------------------

function explanationOf(coaching: Coaching): Explanation {
  return coaching.explanation;
}

function bookAnswer(coaching: Coaching): string {
  if (coaching.kind === 'insurance') return coaching.take ? 'take it' : 'decline';
  return coaching.recommendation.action;
}

/** Cents per dollar wagered, signed. The bars are a comparison, so the sign leads. */
function signedCents(ev: number): string {
  const cents = Math.round(Math.abs(ev) * 100);
  if (cents === 0) return '0¢';
  return `${ev > 0 ? '+' : '−'}${cents}¢`;
}

/**
 * The money a deviation is worth, phrased as the *expected* value it is.
 *
 * "That cost about $2.53" is a sentence this app is not entitled to say. The
 * hand has not finished, and the player may well win it — `moneyDelta` is an EV
 * difference priced at the stake (SPEC §9 calls it *estimated* EV lost), not a
 * result. A verdict that reads as a settled loss and is then contradicted by
 * the player winning the hand teaches them to distrust the coach, which is the
 * one thing the app cannot afford. Same rule as explain.ts decision 15: no
 * sentence here is allowed to be capable of lying.
 */
function signedMoney(delta: number): string {
  const amount = formatExpectation(Math.abs(delta));
  // Half a cent, now expressed in cents rather than dollars.
  if (Math.abs(delta) < 0.5) return 'That costs nothing on average.';
  return delta < 0
    ? `On average that costs about ${amount}.`
    : `On average that gains about ${amount}.`;
}

function verdictStyle(decision: Decision) {
  return decision.wasRecommended ? styles.cardCorrect : styles.cardDeviation;
}

// --- Styles ----------------------------------------------------------------

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0f3830',
    borderTopWidth: 3,
    borderTopColor: '#e8c56a',
    paddingHorizontal: 14,
  },
  cardCorrect: { borderTopColor: '#6fbf8b' },
  cardDeviation: { borderTopColor: '#d98f4a' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  headerText: { flex: 1, gap: 2 },
  chevron: { color: '#8fbfa8', fontSize: 16 },
  headline: { color: '#f7f2e4', fontSize: 15, fontWeight: '700' },
  summary: { color: '#cfe8dc', fontSize: 13, lineHeight: 18 },

  sheet: { maxHeight: 240 },
  sheetBody: { paddingBottom: 12, gap: 12 },
  detail: { color: '#e6efe9', fontSize: 13, lineHeight: 19 },
  advanced: { color: '#e8c56a', fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  footnote: { color: '#8fbfa8', fontSize: 11, lineHeight: 15, fontStyle: 'italic' },

  bars: { gap: 6 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { color: '#cfe8dc', fontSize: 12, width: 72 },
  barLabelBest: { color: '#e8c56a', fontWeight: '700' },
  barTrack: {
    flex: 1,
    height: 14,
    backgroundColor: '#0a2b23',
    borderRadius: 3,
    justifyContent: 'center',
  },
  barZero: {
    position: 'absolute',
    left: '50%',
    width: 1,
    top: 0,
    bottom: 0,
    backgroundColor: '#3d6b5c',
  },
  barFill: { position: 'absolute', height: 10, borderRadius: 2 },
  barPositive: { backgroundColor: '#6fbf8b' },
  barNegative: { backgroundColor: '#c9614f' },
  barValue: { color: '#f2f7f4', fontSize: 12, width: 52, textAlign: 'right' },
});
