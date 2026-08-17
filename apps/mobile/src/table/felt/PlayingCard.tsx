/**
 * A card on the felt.
 *
 * SPEC §10 wants the 52 faces as SVG art. This is not that, and it is not
 * pretending to be: it is a card *shape* — the real 2.5:3.5 aspect ratio, a
 * corner index, a centre pip, a patterned back — drawn in plain views, so the
 * felt can be laid out and driven now without pulling in a renderer dependency
 * that the by-hand `expo export --platform web` check would then have to
 * survive. When the art lands it replaces the inside of this component and
 * nothing that positions cards has to move.
 *
 * The face-down arm draws no rank because it *has* none: `ShownCard`'s
 * `facing: 'down'` variant carries no `card` field at all (shown.ts decision
 * 57), so a back that leaked the hole card would not compile.
 */

import { StyleSheet, Text, View } from 'react-native';
import type { Card, ShownCard } from '@bj/engine';

/** A real card is 2.5" × 3.5". Every other dimension here is derived from the width. */
const ASPECT = 3.5 / 2.5;

export function PlayingCard({ shown, width }: { readonly shown: ShownCard; readonly width: number }) {
  const height = width * ASPECT;
  const frame = { width, height, borderRadius: Math.max(2, width * 0.09) };

  if (shown.facing === 'down') {
    return (
      <View style={[styles.card, styles.back, frame]}>
        <View style={[styles.backPattern, { borderRadius: Math.max(1, width * 0.05) }]} />
      </View>
    );
  }

  const red = isRed(shown.card);
  const index = `${shown.card.rank}${PIPS[shown.card.suit]}`;

  return (
    <View style={[styles.card, frame]}>
      {/* The corner index is what a real card is read by when hands overlap:
          only the top-left corner of an underlying card is ever visible. */}
      <Text
        style={[styles.index, { fontSize: width * 0.34 }, red ? styles.red : styles.black]}
        numberOfLines={1}
      >
        {index}
      </Text>
      <Text style={[styles.centrePip, { fontSize: width * 0.5 }, red ? styles.red : styles.black]}>
        {PIPS[shown.card.suit]}
      </Text>
    </View>
  );
}

/**
 * A hand, fanned.
 *
 * Cards overlap by design rather than to save space: it is what a hand on a felt
 * looks like, and it keeps a five-card hand the same width as a three-card one,
 * so a seat never grows sideways into its neighbour on the arc mid-draw.
 */
export function CardFan({ cards, width }: { readonly cards: readonly ShownCard[]; readonly width: number }) {
  return (
    // The fan sizes itself. Its cards are absolutely positioned and contribute
    // no width, so a caller that had to state the width would be the second
    // place `EXPOSED` is applied — and the two would drift the first time it
    // changed.
    <View
      style={[styles.fan, { width: fanWidth(cards.length, width), height: width * ASPECT }]}
    >
      {cards.map((shown, index) => (
        <View key={index} style={[styles.fanned, { left: index * width * EXPOSED, zIndex: index }]}>
          <PlayingCard shown={shown} width={width} />
        </View>
      ))}
    </View>
  );
}

/**
 * How much of each card underneath stays visible.
 *
 * It has to clear the corner index, which is what a fanned hand is actually read
 * by — at 0.42 the index was being clipped by the card on top of it and a hand
 * read as one card with slivers beside it. This is the number that decides
 * whether a five-card hand is countable at a glance from the far end of the arc,
 * so it is named rather than defaulted at the call site.
 */
const EXPOSED = 0.56;

export function fanWidth(count: number, width: number): number {
  return count === 0 ? 0 : width + (count - 1) * width * EXPOSED;
}

const PIPS: Record<Card['suit'], string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

function isRed(card: Card): boolean {
  return card.suit === 'H' || card.suit === 'D';
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fdfdf7',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c9c9bd',
    overflow: 'hidden',
    // The lift is what makes the felt read as 2.5D rather than flat.
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  index: { position: 'absolute', top: 1, left: 3, fontWeight: '700', letterSpacing: -0.5 },
  centrePip: { position: 'absolute', bottom: 1, right: 3, opacity: 0.9 },
  black: { color: '#15171a' },
  red: { color: '#c0293b' },

  back: { backgroundColor: '#7a2230', alignItems: 'center', justifyContent: 'center' },
  backPattern: {
    position: 'absolute',
    top: '10%',
    left: '10%',
    right: '10%',
    bottom: '10%',
    borderWidth: 1,
    borderColor: '#d8a0aa',
    backgroundColor: '#8c2a39',
  },

  fan: { flexDirection: 'row', alignItems: 'flex-start' },
  fanned: { position: 'absolute', top: 0 },
});
