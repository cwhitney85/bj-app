import { describe, it, expect } from 'vitest';

import {
  RANKS,
  SUITS,
  buildDecks,
  shuffle,
  compIndex,
  compIndexValue,
  cardValue,
  isTenValue,
  compositionOf,
  createShoe,
  reshuffle,
  dealCard,
  cutCardReached,
  cardsRemaining,
  dealtCards,
  type Card,
  type Composition,
  type Rank,
  type Shoe,
} from '../src/cards.js';
import { mulberry32 } from '../src/rng.js';

const VEGAS = { deckCount: 6, penetration: 0.75 } as const;
const SHOE_SIZE = 312;
const CUT_INDEX = 234; // floor(312 * 0.75)

/** A full 6-deck shoe: 24 of each of A..9, and 96 tens (T+J+Q+K). */
const FULL_6D_COMPOSITION: Composition = [24, 24, 24, 24, 24, 24, 24, 24, 24, 96];

function idsOf(cards: readonly Card[]): string[] {
  return cards.map((c) => c.id);
}

/** Order-insensitive fingerprint of a set of cards. */
function multiset(cards: readonly Card[]): string[] {
  return idsOf(cards).slice().sort();
}

describe('buildDecks', () => {
  it('builds 312 cards for 6 decks with the right rank and suit counts', () => {
    const cards = buildDecks(6);
    expect(cards).toHaveLength(SHOE_SIZE);

    for (const rank of RANKS) {
      expect(cards.filter((c) => c.rank === rank)).toHaveLength(24);
    }
    for (const suit of SUITS) {
      expect(cards.filter((c) => c.suit === suit)).toHaveLength(78);
    }
  });

  it('gives every card a unique id', () => {
    for (const deckCount of [1, 2, 6, 8]) {
      const cards = buildDecks(deckCount);
      expect(cards).toHaveLength(deckCount * 52);
      expect(new Set(idsOf(cards)).size).toBe(cards.length);
    }
  });

  it('produces the same cards regardless of when it is called', () => {
    expect(idsOf(buildDecks(6))).toEqual(idsOf(buildDecks(6)));
  });
});

describe('rank helpers', () => {
  it('maps ranks to composition buckets: A→0, 2..9→1..8, T/J/Q/K→9', () => {
    expect(compIndex('A')).toBe(0);
    const numeric: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9'];
    numeric.forEach((rank, i) => {
      expect(compIndex(rank)).toBe(i + 1);
    });
    for (const rank of ['T', 'J', 'Q', 'K'] as const) {
      expect(compIndex(rank)).toBe(9);
    }
  });

  it('keeps every rank inside the ten-bucket range', () => {
    for (const rank of RANKS) {
      const i = compIndex(rank);
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThanOrEqual(9);
    }
  });

  it('values an ace high and all faces as ten', () => {
    expect(cardValue('A')).toBe(11);
    for (const rank of ['T', 'J', 'Q', 'K'] as const) {
      expect(cardValue(rank)).toBe(10);
      expect(isTenValue(rank)).toBe(true);
    }
    for (const rank of ['2', '3', '4', '5', '6', '7', '8', '9'] as const) {
      expect(cardValue(rank)).toBe(Number(rank));
      expect(isTenValue(rank)).toBe(false);
    }
    expect(isTenValue('A')).toBe(false);
  });

  it('agrees with compIndexValue for every rank', () => {
    for (const rank of RANKS) {
      expect(compIndexValue(compIndex(rank))).toBe(cardValue(rank));
    }
  });
});

describe('compositionOf', () => {
  it('folds J/Q/K into the ten bucket for a full 6-deck shoe', () => {
    const comp = compositionOf(buildDecks(6));
    expect(comp).toEqual(FULL_6D_COMPOSITION);
    // The ten bucket is 96 (not 24) precisely because it holds T, J, Q and K.
    expect(comp[9]).toBe(24 * 4);
    expect(comp.reduce((a, b) => a + b, 0)).toBe(SHOE_SIZE);
  });

  it('is empty for no cards and order-independent', () => {
    expect(compositionOf([])).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const cards = buildDecks(1);
    const shuffled = shuffle(buildDecks(1), mulberry32(3));
    expect(compositionOf(cards)).toEqual(compositionOf(shuffled));
  });
});

describe('shuffle', () => {
  it('is a permutation — the multiset of cards is unchanged', () => {
    for (const seed of [0, 1, 42, 8675309]) {
      const original = buildDecks(6);
      const shuffled = shuffle(buildDecks(6), mulberry32(seed));
      expect(shuffled).toHaveLength(SHOE_SIZE);
      expect(multiset(shuffled)).toEqual(multiset(original));
      expect(compositionOf(shuffled)).toEqual(compositionOf(original));
    }
  });

  it('actually reorders the deck', () => {
    const original = idsOf(buildDecks(6));
    const shuffled = idsOf(shuffle(buildDecks(6), mulberry32(12345)));
    expect(shuffled).not.toEqual(original);
    // Sanity: the vast majority of positions should have changed.
    const moved = shuffled.filter((id, i) => id !== original[i]).length;
    expect(moved).toBeGreaterThan(SHOE_SIZE * 0.9);
  });
});

describe('createShoe', () => {
  it('starts full, unindexed, with the cut card at 75% penetration', () => {
    const shoe = createShoe(1, VEGAS);
    expect(shoe.cards).toHaveLength(SHOE_SIZE);
    expect(shoe.index).toBe(0);
    expect(shoe.deckCount).toBe(6);
    expect(shoe.cutIndex).toBe(CUT_INDEX);
    expect(shoe.composition).toEqual(FULL_6D_COMPOSITION);
    expect(cardsRemaining(shoe)).toBe(SHOE_SIZE);
    expect(dealtCards(shoe)).toEqual([]);
  });

  it('is deterministic: the same seed gives an identical card order', () => {
    for (const seed of [0, 1, 42, 1337, 999999]) {
      const a = createShoe(seed, VEGAS);
      const b = createShoe(seed, VEGAS);
      expect(idsOf(a.cards)).toEqual(idsOf(b.cards));
      expect(a.composition).toEqual(b.composition);
      expect(a.cutIndex).toBe(b.cutIndex);
    }
  });

  it('gives different seeds a different card order', () => {
    const seeds = [0, 1, 2, 42, 1337, 999999];
    const orders = seeds.map((seed) => idsOf(createShoe(seed, VEGAS).cards).join(','));
    expect(new Set(orders).size).toBe(seeds.length);
  });

  it('holds a permutation of a freshly built shoe', () => {
    const shoe = createShoe(777, VEGAS);
    expect(multiset(shoe.cards)).toEqual(multiset(buildDecks(6)));
  });
});

describe('shoe integrity', () => {
  it('deals the whole shoe without repeating a card, keeping composition exact', () => {
    // The load-bearing test from SPEC §8: no card dealt twice, and the cached
    // composition must equal a recount of the undealt remainder at every step.
    let shoe: Shoe = createShoe(20260803, VEGAS);
    const seen = new Set<string>();
    const dealt: Card[] = [];

    for (let i = 0; i < SHOE_SIZE; i++) {
      expect(cardsRemaining(shoe)).toBe(SHOE_SIZE - i);
      expect(shoe.index).toBe(i);

      const draw = dealCard(shoe);
      shoe = draw.shoe;
      dealt.push(draw.card);

      expect(seen.has(draw.card.id)).toBe(false);
      seen.add(draw.card.id);

      const remaining = shoe.cards.slice(shoe.index);
      expect(shoe.composition).toEqual(compositionOf(remaining));
      expect(shoe.composition.reduce((a, b) => a + b, 0)).toBe(remaining.length);
      expect(cardsRemaining(shoe)).toBe(SHOE_SIZE - i - 1);
    }

    expect(seen.size).toBe(SHOE_SIZE);
    expect(multiset(dealt)).toEqual(multiset(buildDecks(6)));
    expect(shoe.composition).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cardsRemaining(shoe)).toBe(0);
  });

  it('throws when dealing from an exhausted shoe', () => {
    let shoe: Shoe = createShoe(5, VEGAS);
    for (let i = 0; i < SHOE_SIZE; i++) shoe = dealCard(shoe).shoe;
    expect(cardsRemaining(shoe)).toBe(0);
    expect(() => dealCard(shoe)).toThrow(/exhausted/i);
  });

  it('deals cards in shoe order', () => {
    let shoe: Shoe = createShoe(11, VEGAS);
    const expected = idsOf(shoe.cards.slice(0, 20));
    const drawn: string[] = [];
    for (let i = 0; i < 20; i++) {
      const draw = dealCard(shoe);
      drawn.push(draw.card.id);
      shoe = draw.shoe;
    }
    expect(drawn).toEqual(expected);
  });

  it('keeps dealt + remaining equal to the full shoe composition', () => {
    let shoe: Shoe = createShoe(64, VEGAS);
    for (let i = 0; i < 150; i++) shoe = dealCard(shoe).shoe;
    const dealtComp = compositionOf(dealtCards(shoe));
    const total = shoe.composition.map((n, i) => n + (dealtComp[i] as number));
    expect(total).toEqual([...FULL_6D_COMPOSITION]);
  });
});

describe('dealCard purity', () => {
  it('does not mutate the shoe it was given', () => {
    const shoe = createShoe(2024, VEGAS);
    const indexBefore = shoe.index;
    const compBefore = [...shoe.composition];
    const cardsBefore = idsOf(shoe.cards);

    const draw = dealCard(shoe);

    expect(shoe.index).toBe(indexBefore);
    expect([...shoe.composition]).toEqual(compBefore);
    expect(idsOf(shoe.cards)).toEqual(cardsBefore);
    expect(draw.shoe).not.toBe(shoe);
    expect(draw.shoe.composition).not.toBe(shoe.composition);
    expect(draw.shoe.index).toBe(indexBefore + 1);
  });

  it('lets the same shoe be dealt from twice with identical results', () => {
    // Purity is what makes counterfactual replay (SPEC §7) possible: branching
    // off the same shoe value must yield the same card both times.
    const shoe = createShoe(31, VEGAS);
    const a = dealCard(shoe);
    const b = dealCard(shoe);
    expect(a.card).toEqual(b.card);
    expect(a.shoe.index).toBe(b.shoe.index);
    expect(a.shoe.composition).toEqual(b.shoe.composition);
    expect(shoe.index).toBe(0);
    expect(shoe.composition).toEqual(FULL_6D_COMPOSITION);
  });
});

describe('cut card', () => {
  it('places the cut card at index 234 for 6 decks at 0.75 penetration', () => {
    expect(createShoe(1, VEGAS).cutIndex).toBe(CUT_INDEX);
  });

  it('is false before cutIndex and true at or after it, flipping exactly once', () => {
    let shoe: Shoe = createShoe(4242, VEGAS);
    expect(cutCardReached(shoe)).toBe(false);

    let transitions = 0;
    let transitionAt = -1;
    let previous = cutCardReached(shoe);

    for (let i = 0; i < SHOE_SIZE; i++) {
      shoe = dealCard(shoe).shoe;
      const now = cutCardReached(shoe);
      if (now !== previous) {
        transitions++;
        transitionAt = shoe.index;
      }
      previous = now;
      expect(now).toBe(shoe.index >= CUT_INDEX);
    }

    expect(transitions).toBe(1);
    expect(transitionAt).toBe(CUT_INDEX);
  });
});

describe('dealtCards', () => {
  it('returns exactly the cards already dealt, in deal order', () => {
    let shoe: Shoe = createShoe(808, VEGAS);
    const drawn: Card[] = [];

    expect(dealtCards(shoe)).toEqual([]);

    for (let i = 0; i < 40; i++) {
      const draw = dealCard(shoe);
      shoe = draw.shoe;
      drawn.push(draw.card);
      expect(dealtCards(shoe)).toHaveLength(i + 1);
      expect(idsOf(dealtCards(shoe))).toEqual(idsOf(drawn));
    }
  });
});

describe('reshuffle', () => {
  it('resets the shoe while preserving deck count and penetration', () => {
    let shoe: Shoe = createShoe(1, VEGAS);
    for (let i = 0; i < 250; i++) shoe = dealCard(shoe).shoe;
    expect(cutCardReached(shoe)).toBe(true);

    const fresh = reshuffle(shoe, 2);

    expect(fresh.deckCount).toBe(6);
    expect(fresh.cutIndex).toBe(CUT_INDEX); // penetration preserved at 0.75
    expect(fresh.index).toBe(0);
    expect(fresh.cards).toHaveLength(SHOE_SIZE);
    expect(fresh.composition).toEqual(FULL_6D_COMPOSITION);
    expect(cardsRemaining(fresh)).toBe(SHOE_SIZE);
    expect(cutCardReached(fresh)).toBe(false);
    expect(dealtCards(fresh)).toEqual([]);
    expect(multiset(fresh.cards)).toEqual(multiset(buildDecks(6)));
  });

  it('is deterministic in its new seed and reorders the cards', () => {
    const shoe = createShoe(1, VEGAS);
    expect(idsOf(reshuffle(shoe, 99).cards)).toEqual(idsOf(reshuffle(shoe, 99).cards));
    expect(idsOf(reshuffle(shoe, 99).cards)).not.toEqual(idsOf(reshuffle(shoe, 100).cards));
    expect(idsOf(reshuffle(shoe, 99).cards)).not.toEqual(idsOf(shoe.cards));
  });

  it('survives repeated reshuffles with penetration intact', () => {
    let shoe: Shoe = createShoe(1, VEGAS);
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 240; i++) shoe = dealCard(shoe).shoe;
      shoe = reshuffle(shoe, round + 500);
      expect(shoe.cutIndex).toBe(CUT_INDEX);
      expect(shoe.deckCount).toBe(6);
      expect(shoe.index).toBe(0);
      expect(shoe.composition).toEqual(FULL_6D_COMPOSITION);
    }
  });

  it('does not mutate the shoe it was given', () => {
    let shoe: Shoe = createShoe(1, VEGAS);
    for (let i = 0; i < 10; i++) shoe = dealCard(shoe).shoe;
    const indexBefore = shoe.index;
    const compBefore = [...shoe.composition];
    const orderBefore = idsOf(shoe.cards);

    reshuffle(shoe, 7);

    expect(shoe.index).toBe(indexBefore);
    expect([...shoe.composition]).toEqual(compBefore);
    expect(idsOf(shoe.cards)).toEqual(orderBefore);
  });
});

describe('other deck counts and penetrations', () => {
  it('scales size and cut index correctly', () => {
    const cases: Array<[number, number, number, number]> = [
      // deckCount, penetration, expected size, expected cutIndex
      [1, 0.75, 52, 39],
      [2, 0.5, 104, 52],
      [6, 0.75, 312, 234],
      [8, 0.8, 416, 332],
    ];
    for (const [deckCount, penetration, size, cutIndex] of cases) {
      const shoe = createShoe(3, { deckCount, penetration });
      expect(shoe.cards).toHaveLength(size);
      expect(shoe.cutIndex).toBe(cutIndex);
      expect(shoe.deckCount).toBe(deckCount);
      expect(shoe.composition.reduce((a, b) => a + b, 0)).toBe(size);
    }
  });
});
