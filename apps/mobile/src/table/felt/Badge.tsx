/**
 * The small capsule under a hand carrying its total, or `BUST`.
 *
 * A component of its own for the same reason `handRead.ts` is a module of its
 * own: the felt and SPEC §7's comparison card both draw it, and a badge that
 * looks different in the two places reads as two different facts about the same
 * hand. The values are `Felt.tsx`'s, moved rather than redesigned.
 */

import { StyleSheet, Text, View } from 'react-native';

import { C } from '../../ui/theme';
import type { Tone } from './handRead';

export function Badge({ text, tone }: { readonly text: string; readonly tone: Tone }) {
  if (text === '') return null;
  return (
    <View style={[styles.badge, tone === 'bad' && styles.bad, tone === 'good' && styles.good]}>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  good: { backgroundColor: 'rgba(111,191,139,0.28)' },
  bad: { backgroundColor: 'rgba(224,139,111,0.30)' },
  text: { color: C.text, fontSize: 10, fontWeight: '700' },
});
