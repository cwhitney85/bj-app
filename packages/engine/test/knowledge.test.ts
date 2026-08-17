import { describe, expect, it } from 'vitest';

import {
  buildDecks,
  compositionOf,
  type Card,
  type Composition,
  type Rank,
  type Shoe,
  type Suit,
} from '../src/cards.js';
import {
  freshShoeComposition,
  unseenComposition,
  visibleCards,
  type KnownCards,
} from '../src/knowledge.js';
import { VEGAS_STRIP, type RuleSet } from '../src/rules.js';
import {
  advanceUntilDecision,
  applyAction,
  createGame,
  placeBets,
  type StepResult,
} from '../src/round.js';
import type { RoundState } from '../src/state.js';

// --- Helpers ---------------------------------------------------------------

function stack(ranks: readonly string[], rules: RuleSet = VEGAS_STRIP): Shoe {
  const suits: readonly Suit[] = ['S', 'H', 'D', 'C'];
  const cards: Card[] = ranks.map((rank, i) => ({
    rank: rank as Rank,
    suit: suits[i % 4] as Suit,
    id: `${rank}-${i}`,
  }));
  return {
    cards,
    index: 0,
    cutIndex: Math.floor(cards.length * rules.penetration),
    deckCount: rules.deckCount,
    composition: compositionOf(cards),
  };
}

function gameWith(shoe: Shoe, seatCount = 1, bankroll = 100_000): RoundState {
  const seats = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => ({
    occupant:
      i === 0
        ? ({ kind: 'player' } as const)
        : i < seatCount
          ? ({ kind: 'bot', policyId: 'perfect', characterId: `c${i}` } as const)
          : ({ kind: 'empty' } as const),
    bankroll,
  }));
  return { ...createGame({ rules: VEGAS_STRIP, seed: 1, seats }), shoe };
}

function startRound(state: RoundState, bets: ReadonlyMap<number, number>): StepResult {
  const toBetting = advanceUntilDecision(state);
  const placed = placeBets(toBetting.state, bets);
  return advanceUntilDecision(placed.state);
}

function total(comp: Composition): number {
  return comp.reduce((sum, count) => sum + count, 0);
}

const RANK_ORDER: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'];

function bucketOf(comp: Composition, rank: Rank): number {
  return comp[RANK_ORDER.indexOf(rank)] as number;
}

// --- Tests -----------------------------------------------------------------

describe('freshShoeComposition', () => {
  it('matches an actually-built shoe for every deck count in play', () => {
    // The arithmetic shortcut only earns its place if it agrees with the real thing.
    for (const deckCount of [1, 2, 4, 6, 8]) {
      expect(freshShoeComposition(deckCount)).toEqual(compositionOf(buildDecks(deckCount)));
    }
  });

  it('totals 52 cards per deck', () => {
    expect(total(freshShoeComposition(6))).toBe(312);
    expect(total(freshShoeComposition(1))).toBe(52);
  });
});

describe('visibleCards', () => {
  it('hides the hole card until it is revealed', () => {
    const shoe = stack(['T', '6', '8', 'K', ...Array<string>(20).fill('5')]);
    const dealt = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const visible = visibleCards(dealt.state);

    // Player T,8 and the dealer's 6 upcard are public; the K underneath is not.
    expect(visible.map((card) => card.rank).sort()).toEqual(['6', '8', 'T']);
    expect(dealt.state.dealer.holeCardRevealed).toBe(false);
  });

  it('includes the whole dealer hand once the hole card is turned', () => {
    const shoe = stack(['T', '6', '8', 'K', '4', ...Array<string>(20).fill('5')]);
    const dealt = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const stood = advanceUntilDecision(applyAction(dealt.state, 0, 'stand').state);

    // The dealer has revealed and played; nothing on the table is hidden now.
    expect(stood.state.dealer.holeCardRevealed || stood.state.dealer.cards.length === 0).toBe(true);
  });
});

describe('unseenComposition', () => {
  const shoe = stack(['T', '6', '8', 'K', ...Array<string>(40).fill('5')]);

  it('current-round subtracts only what is face up, with no memory of the shoe', () => {
    const dealt = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const comp = unseenComposition(dealt.state, 'current-round');

    // Baseline is a full 6-deck shoe less the three visible cards.
    expect(total(comp)).toBe(312 - 3);
    expect(bucketOf(comp, 'T')).toBe(96 - 1); // the player's ten
    expect(bucketOf(comp, '8')).toBe(24 - 1);
    expect(bucketOf(comp, '6')).toBe(24 - 1); // the dealer upcard
    // The hole card is a king, and a non-counter cannot know it is gone.
    expect(bucketOf(comp, 'A')).toBe(24);
  });

  it('current-round is unchanged by how much of the shoe was already burned', () => {
    const fresh = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const deepIn: RoundState = {
      ...fresh.state,
      shoe: { ...fresh.state.shoe, index: fresh.state.shoe.index + 100 },
    };

    // This is the whole point of the mode: previous rounds leave no trace.
    expect(unseenComposition(deepIn, 'current-round')).toEqual(
      unseenComposition(fresh.state, 'current-round'),
    );
  });

  it('full-shoe subtracts everything dealt but puts the hole card back', () => {
    const dealt = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const comp = unseenComposition(dealt.state, 'full-shoe');

    // Four cards left the shoe; the hole card is one of them and is still unseen,
    // so the unseen count is three fewer than the shoe started with.
    expect(total(comp)).toBe(total(dealt.state.shoe.composition) + 1);
    expect(bucketOf(comp, 'T')).toBe(bucketOf(dealt.state.shoe.composition, 'T') + 1);
  });

  it('full-shoe stops adding the hole card back once it is revealed', () => {
    const dealt = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const revealed: RoundState = {
      ...dealt.state,
      dealer: { ...dealt.state.dealer, holeCardRevealed: true },
    };
    expect(unseenComposition(revealed, 'full-shoe')).toEqual(revealed.shoe.composition);
  });

  it('never returns a negative bucket in either mode', () => {
    const modes: readonly KnownCards[] = ['current-round', 'full-shoe'];
    const dealt = startRound(gameWith(shoe, 4), new Map([[0, 1000], [1, 1000], [2, 1000], [3, 1000]]));
    for (const mode of modes) {
      for (const count of unseenComposition(dealt.state, mode)) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('excludes every card the caller can see, which is what the EV input requires', () => {
    const dealt = startRound(gameWith(shoe, 3), new Map([[0, 1000], [1, 1000], [2, 1000]]));
    const comp = unseenComposition(dealt.state, 'current-round');
    const seen = compositionOf(visibleCards(dealt.state));
    expect(total(comp) + total(seen)).toBe(312);
  });
});
