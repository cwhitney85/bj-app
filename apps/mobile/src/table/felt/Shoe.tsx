/**
 * The shoe and the discard tray (SPEC §9: "a discard tray that visibly fills
 * toward the cut card").
 *
 * This is the one thing on the felt that tells a player how deep into the shoe
 * they are, which is the physical fact counting rests on — so it is the piece
 * M7 needs on screen before a true count means anything to look at.
 *
 * **It is drawn from `shoeIndex` and the rule set, and computes no game state.**
 * `ShownTable.shoeIndex` is maintained card by card by the projection and reset
 * at each `RoundStarted` from the event itself (shown.ts); the deck count and
 * the penetration are declared table setup. Dividing one by the other is
 * arithmetic about a rectangle, not about the game — the felt is not entitled to
 * work out anything the engine did not narrate, and it does not.
 */

import { StyleSheet, Text, View } from 'react-native';
import type { RuleSet } from '@bj/engine';

import { C } from '../../ui/theme';

const CARDS_PER_DECK = 52;

export function Shoe({
  rules,
  shoeIndex,
  shufflePending,
}: {
  readonly rules: RuleSet;
  /** Cards dealt since the last shuffle. */
  readonly shoeIndex: number;
  readonly shufflePending: boolean;
}) {
  const total = rules.deckCount * CARDS_PER_DECK;
  // Clamped rather than trusted: the cut card is passed mid-round and the shoe
  // is not reshuffled until cleanup, so `shoeIndex` legitimately runs a few
  // cards beyond the cut and could in principle reach the end of the shoe.
  const dealt = Math.min(1, Math.max(0, shoeIndex / total));
  const cut = Math.min(1, Math.max(0, rules.penetration));

  return (
    <View style={styles.tray} accessibilityLabel={`${shoeIndex} of ${total} cards dealt`}>
      <View style={styles.well}>
        {/* Fills from the bottom, like a real tray. */}
        <View style={[styles.discards, { height: `${dealt * 100}%` }]} />
        {/* The cut card sits at the depth the shuffle happens, and the tray
            filling up to it is the whole visual. */}
        <View style={[styles.cutCard, { bottom: `${cut * 100}%` }]} />
      </View>
      <Text style={styles.caption}>
        {shufflePending ? 'shuffling' : `${Math.round(dealt * 100)}%`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tray: { alignItems: 'center', gap: 3 },
  well: {
    width: 26,
    height: 54,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: C.edge,
    backgroundColor: C.well,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  discards: { width: '100%', backgroundColor: '#c8b58a' },
  cutCard: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: C.accent },
  caption: { color: C.textFaintest, fontSize: 9 },
});
