/**
 * How a hand reads (`handRead.ts`).
 *
 * These three functions were inside `Felt.tsx` until SPEC §7's comparison card
 * needed the same answers, and the reason to test them now is the reason they
 * moved: two renderers reading one hand must say one thing about it. A hand
 * that badges `BUST` on the felt and `22` in the card is not a rendering bug
 * anyone would file — it is two plausible facts, and the player has to decide
 * which to believe.
 */

import type { ShownHand } from '@bj/engine';
import { describe, expect, it } from 'vitest';

import { status, tone, total } from '../src/table/felt/handRead';

const BASE: ShownHand = {
  cards: [],
  bet: 500,
  total: 17,
  soft: false,
  fromSplit: false,
  doubled: false,
  standing: false,
  busted: false,
  surrendered: false,
  outcome: null,
  net: null,
};

function hand(over: Partial<ShownHand>): ShownHand {
  return { ...BASE, ...over };
}

describe('total', () => {
  it('names a soft total as soft, because the two play differently', () => {
    expect(total(17, false)).toBe('17');
    expect(total(17, true)).toBe('soft 17');
  });

  it('says nothing about a hand that has no total yet', () => {
    // A split hand between its first and second card (M1 decision 4). The badge
    // draws nothing on the empty string, which is what a real table shows.
    expect(total(null, false)).toBe('');
    expect(total(null, true)).toBe('');
  });
});

describe('status', () => {
  it('reports a bust as a bust and not as its total', () => {
    // The total is still a number — 22 — and printing it would be true and
    // useless. `busted` outranks everything, including `doubled`.
    expect(status(hand({ total: 22, busted: true }))).toBe('BUST');
    expect(status(hand({ total: 24, busted: true, doubled: true }))).toBe('BUST');
  });

  it('marks a doubled hand, because the stake is not the base bet', () => {
    expect(status(hand({ total: 11, doubled: true }))).toBe('11 ×2');
  });

  it('marks a finished hand', () => {
    expect(status(hand({ total: 20, standing: true }))).toBe('20 ✓');
    expect(status(hand({ total: 20, soft: true, standing: true }))).toBe('soft 20 ✓');
  });

  it('is just the total while the hand can still act', () => {
    expect(status(hand({ total: 12 }))).toBe('12');
  });

  it('is total for every hand, including one with no total', () => {
    expect(status(hand({ total: null }))).toBe('');
    expect(status(hand({ total: null, standing: true }))).toBe(' ✓');
  });
});

describe('tone', () => {
  it('colours a lost hand as lost and a finished one as safe', () => {
    expect(tone(hand({ busted: true }))).toBe('bad');
    expect(tone(hand({ surrendered: true }))).toBe('bad');
    expect(tone(hand({ standing: true }))).toBe('good');
    expect(tone(hand({}))).toBe('plain');
  });

  it('does not call a busted hand good just because it stopped drawing', () => {
    // `standing` and `busted` can both be set on a settled hand; bust wins.
    expect(tone(hand({ standing: true, busted: true }))).toBe('bad');
  });
});
