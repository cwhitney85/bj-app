/**
 * A bet, drawn as the chips it is made of (SPEC §9).
 *
 * The decomposition is `chips.ts` and is tested; this file is the elevation —
 * chips stack upward, each one sitting slightly above the one below, so the
 * stack's height *is* the size of the bet. That is the whole reason to draw
 * chips rather than print a number: a doubled bet is visibly twice as tall.
 */

import { StyleSheet, Text, View } from 'react-native';

import { C } from '../../ui/theme';
import { CHIP_COLORS, chipsFor, type ChipDenomination } from './chips';
import { formatMoney } from '../../ui/money';

/** How much of each chip below stays visible. A real stack shows the edge only. */
const RISE = 0.22;

/** Past this the stack is drawn as a short pile with a count beside it. */
const MAX_DRAWN = 8;

export function ChipStack({
  amount,
  size = 22,
  label,
}: {
  readonly amount: number;
  /** Chip diameter. Scaled by the seat's perspective. */
  readonly size?: number;
  /** Printed beneath the stack. Omit for a bare stack. */
  readonly label?: string;
}) {
  if (amount <= 0) return null;

  const { runs } = chipsFor(amount);

  // Bottom of the stack first, which is largest denomination first — the way a
  // dealer stacks, and the way it must be drawn for the big chips to be at the
  // bottom of the pile.
  const chips: ChipDenomination[] = runs.flatMap((run) =>
    Array.from({ length: run.count }, () => run.denomination),
  );
  const drawn = chips.slice(0, MAX_DRAWN);
  const hidden = chips.length - drawn.length;
  const height = size * (1 + RISE * Math.max(0, drawn.length - 1)) * 0.62;

  return (
    <View style={styles.stack}>
      <View style={{ width: size, height }}>
        {drawn.map((denomination, index) => (
          <Chip
            key={index}
            denomination={denomination}
            size={size}
            // Index 0 is the bottom chip, so it sits lowest and draws first.
            bottom={index * size * RISE * 0.62}
            depth={index}
          />
        ))}
      </View>
      {/* The label carries the whole amount, including `remainder` — the part no
          chip can express (chips.ts). A $5 bet insures for $2.50, and the felt
          says $2.50 with no chip under it rather than rounding to one. */}
      <Text style={[styles.amount, { fontSize: Math.max(9, size * 0.42) }]}>
        {label ?? formatMoney(amount)}
        {hidden > 0 ? ` (+${hidden})` : ''}
      </Text>
    </View>
  );
}

function Chip({
  denomination,
  size,
  bottom,
  depth,
}: {
  readonly denomination: ChipDenomination;
  readonly size: number;
  readonly bottom: number;
  readonly depth: number;
}) {
  const { face, edge } = CHIP_COLORS[denomination];
  return (
    <View
      style={[
        styles.chip,
        {
          bottom,
          zIndex: depth,
          width: size,
          // Chips are seen at a shallow angle, so a disc reads as an ellipse.
          // This is the cheapest honest 2.5D cue on the felt.
          height: size * 0.62,
          borderRadius: size / 2,
          backgroundColor: face,
          borderColor: edge,
          borderWidth: Math.max(1, size * 0.09),
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: 'center', gap: 2 },
  chip: {
    position: 'absolute',
    left: 0,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  amount: { color: C.text, fontWeight: '700' },
});
