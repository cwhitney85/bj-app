/**
 * How a hand reads: total, status line, tone.
 *
 * Lifted out of `Felt.tsx` because it is no longer the felt's alone. SPEC §7's
 * comparison card draws the same hands from a different fold, and two
 * independent answers to "what does this hand say" is how a hand comes to read
 * `BUST` on the felt and `22` in the card — a divergence nothing would throw on
 * and nobody would look for.
 *
 * Pure and total: every `ShownHand` yields a string, including the ones with no
 * total yet.
 */

import type { ShownHand } from '@bj/engine';

export type Tone = 'plain' | 'good' | 'bad';

/**
 * `null` is a split hand still waiting for its second card (M1 decision 4) — a
 * real table shows no badge there, so this returns the empty string and the
 * badge draws nothing.
 */
export function total(value: number | null, soft: boolean): string {
  if (value === null) return '';
  return soft ? `soft ${value}` : `${value}`;
}

export function status(hand: ShownHand): string {
  if (hand.busted) return 'BUST';
  if (hand.surrendered) return 'surr';
  const shown = total(hand.total, hand.soft);
  if (hand.doubled) return `${shown} ×2`;
  return hand.standing ? `${shown} ✓` : shown;
}

export function tone(hand: ShownHand): Tone {
  if (hand.busted || hand.surrendered) return 'bad';
  return hand.standing ? 'good' : 'plain';
}
