/**
 * Cards, the shoe, and the composition vector.
 *
 * The shoe is a fully pre-shuffled array plus a draw index. That representation
 * is deliberate: "deterministic given a seed and draw index" (SPEC §7) is what
 * lets a round be replayed with one player's decisions changed. A lazy
 * draw-on-demand PRNG would not have that property, because a counterfactual
 * that draws a different *number* of cards would desynchronise the stream.
 */

import { mulberry32, type Rng } from './rng.js';

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

export type Card = {
  readonly rank: Rank;
  readonly suit: Suit;
  /** Stable identity for UI animation keys and the no-card-dealt-twice test. */
  readonly id: string;
};

/**
 * Counts of A,2,3,4,5,6,7,8,9,T — ten buckets, with T folding in J/Q/K.
 * This is the shoe representation the EV calculator consumes (SPEC §5.2).
 */
export type Composition = readonly [
  number, number, number, number, number,
  number, number, number, number, number,
];

export type MutableComposition = [
  number, number, number, number, number,
  number, number, number, number, number,
];

/**
 * Index into a Composition. A=0, 2..9 = 1..8, T=9.
 *
 * The literal union is not decoration: under `noUncheckedIndexedAccess` a plain
 * `number` index into the ten-element tuple widens to `number | undefined`, and
 * every caller would have to assert away a bucket that provably exists. A table
 * rather than arithmetic keeps that guarantee visible to the compiler.
 */
export type CompIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const COMP_INDEX: Readonly<Record<Rank, CompIndex>> = {
  A: 0,
  '2': 1,
  '3': 2,
  '4': 3,
  '5': 4,
  '6': 5,
  '7': 6,
  '8': 7,
  '9': 8,
  T: 9,
  J: 9,
  Q: 9,
  K: 9,
};

export function compIndex(rank: Rank): CompIndex {
  return COMP_INDEX[rank];
}

/** Blackjack value of a rank, with an ace counted high. Hand evaluation demotes. */
export function cardValue(rank: Rank): number {
  switch (rank) {
    case 'A': return 11;
    case 'T': case 'J': case 'Q': case 'K': return 10;
    default: return Number(rank);
  }
}

/** Value of a composition bucket index. Bucket 0 (ace) counts high. */
export function compIndexValue(index: number): number {
  if (index === 0) return 11;
  if (index === 9) return 10;
  return index + 1;
}

export function isTenValue(rank: Rank): boolean {
  return cardValue(rank) === 10;
}

// --- Shoe ------------------------------------------------------------------

export type Shoe = {
  readonly cards: readonly Card[];
  /** Index of the next card to be dealt. */
  readonly index: number;
  /** Once `index` reaches this, the cut card has been passed. */
  readonly cutIndex: number;
  readonly deckCount: number;
  /** Cards remaining, bucketed for the EV calculator. Kept in step with `index`. */
  readonly composition: Composition;
};

export function buildDecks(deckCount: number): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < deckCount; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ rank, suit, id: `${rank}${suit}#${d}` });
      }
    }
  }
  return cards;
}

/** In-place Fisher-Yates, drawing from the supplied stream. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

export function compositionOf(cards: readonly Card[]): Composition {
  const comp: MutableComposition = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const card of cards) comp[compIndex(card.rank)]++;
  return comp;
}

export type ShoeOptions = {
  readonly deckCount: number;
  /** Fraction of the shoe dealt before the cut card surfaces, e.g. 0.75. */
  readonly penetration: number;
};

export function createShoe(seed: number, options: ShoeOptions): Shoe {
  return createShoeFrom(shuffle(buildDecks(options.deckCount), mulberry32(seed)), options);
}

/** Reshuffle in place, keeping the same rule parameters. Fresh stream, new seed. */
export function reshuffle(shoe: Shoe, seed: number): Shoe {
  return createShoeFrom(shuffle(buildDecks(shoe.deckCount), mulberry32(seed)), {
    deckCount: shoe.deckCount,
    penetration: shoe.cutIndex / shoe.cards.length,
  });
}

function createShoeFrom(cards: Card[], options: ShoeOptions): Shoe {
  return {
    cards,
    index: 0,
    cutIndex: Math.floor(cards.length * options.penetration),
    deckCount: options.deckCount,
    composition: compositionOf(cards),
  };
}

export type Draw = {
  readonly shoe: Shoe;
  readonly card: Card;
};

/**
 * Deal one card. Pure: returns the next shoe rather than mutating.
 *
 * Running out is a programming error, not a game state — the cut card must
 * have triggered a shuffle long before a 6-deck shoe is exhausted.
 */
export function dealCard(shoe: Shoe): Draw {
  const card = shoe.cards[shoe.index];
  if (card === undefined) throw new Error('Shoe exhausted: cut card handling is broken');
  const composition = shoe.composition.slice() as MutableComposition;
  composition[compIndex(card.rank)]--;
  return {
    card,
    shoe: { ...shoe, index: shoe.index + 1, composition },
  };
}

/** True once the cut card has been reached; the round in progress still finishes. */
export function cutCardReached(shoe: Shoe): boolean {
  return shoe.index >= shoe.cutIndex;
}

export function cardsRemaining(shoe: Shoe): number {
  return shoe.cards.length - shoe.index;
}

/** Cards dealt since the last shuffle — the `full-shoe` counting view (SPEC §5.3). */
export function dealtCards(shoe: Shoe): readonly Card[] {
  return shoe.cards.slice(0, shoe.index);
}
