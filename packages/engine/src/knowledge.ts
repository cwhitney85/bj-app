/**
 * What the EV calculator is allowed to know (SPEC §5.3).
 *
 * This module exists to make the difference between "reading the table" and
 * "counting cards" a single explicit parameter rather than an assumption buried
 * in the calculator. Both modes produce the same shape — a `Composition` of
 * unseen cards — so the EV code has one code path and this file carries the
 * entire distinction:
 *
 *   current-round  the sharp player. Starts from a full fresh shoe and removes
 *                  only what is face up on the table right now. No memory of
 *                  previous rounds, so nothing has to be memorised. This is the
 *                  default, and it is *not* card counting.
 *   full-shoe      the counter. Everything dealt since the last shuffle is gone.
 *                  Strictly stronger than any human counting system, which is
 *                  why it is opt-in and labelled advanced.
 *
 * Both views treat the dealer's hole card as unseen, because it is. That is not
 * a detail: `shoe.composition` has already removed the hole card from the shoe,
 * so the full-shoe view has to put it back or the calculator would be reasoning
 * about a card no player can see.
 */

import { compIndex, type Card, type Composition, type MutableComposition } from './cards.js';
import type { RoundState } from './state.js';

/**
 * A full unplayed shoe as a composition. Nine ranks appear four times per deck;
 * tens fold J/Q/K in and so appear sixteen times. Computed rather than derived
 * from `buildDecks` because this runs on every recommendation in `current-round`
 * mode, and materialising 312 card objects to immediately bucket them is waste
 * the EV budget (SPEC §5.2) does not need to absorb.
 */
export function freshShoeComposition(deckCount: number): Composition {
  const perRank = 4 * deckCount;
  const tens = 16 * deckCount;
  return [perRank, perRank, perRank, perRank, perRank, perRank, perRank, perRank, perRank, tens];
}

/** Which cards the calculator subtracts. SPEC §5.3. */
export type KnownCards = 'current-round' | 'full-shoe';

/**
 * Every card face up on the table this round: the players' cards, the dealer's
 * upcard, and the rest of the dealer's hand once the hole card is turned.
 *
 * Cards from previous rounds are not here even though they are physically in
 * the discard tray — a player who is not counting has no access to them.
 */
export function visibleCards(state: RoundState): readonly Card[] {
  const cards: Card[] = [];
  for (const seat of state.seats) {
    for (const hand of seat.hands) cards.push(...hand.cards);
  }
  // Before the reveal only the upcard is public. After it, the hole card and
  // every card the dealer draws are.
  if (state.dealer.holeCardRevealed) {
    cards.push(...state.dealer.cards);
  } else if (state.dealer.cards.length > 0) {
    cards.push(state.dealer.cards[0] as Card);
  }
  return cards;
}

/**
 * The unseen-card composition the EV calculator should reason over.
 *
 * The result always excludes the player's own cards and the dealer upcard,
 * which is exactly the precondition `evaluateActions` documents for its
 * `composition` input.
 */
export function unseenComposition(state: RoundState, mode: KnownCards): Composition {
  return mode === 'full-shoe' ? fullShoeView(state) : currentRoundView(state);
}

/** Cards left in the shoe, plus the hole card, which is dealt but not seen. */
function fullShoeView(state: RoundState): Composition {
  const comp = state.shoe.composition.slice() as MutableComposition;
  const hole = state.dealer.cards[1];
  if (hole !== undefined && !state.dealer.holeCardRevealed) {
    comp[compIndex(hole.rank)]++;
  }
  return comp;
}

/** A full fresh shoe minus only what is face up right now. */
function currentRoundView(state: RoundState): Composition {
  const comp = freshShoeComposition(state.shoe.deckCount).slice() as MutableComposition;
  for (const card of visibleCards(state)) {
    const index = compIndex(card.rank);
    const count = comp[index];
    // A negative bucket means more of a rank is on the table than the shoe ever
    // held — always an engine bug, never a game state, so it must not pass
    // silently into a probability calculation.
    if (count <= 0) {
      throw new Error(`More ${card.rank}s are visible than a ${state.shoe.deckCount}-deck shoe holds`);
    }
    comp[index] = count - 1;
  }
  return comp;
}
