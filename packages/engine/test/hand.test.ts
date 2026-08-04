import { describe, it, expect } from 'vitest';

import { RANKS, SUITS, cardValue, type Card, type Rank, type Suit } from '../src/cards.js';
import {
  createHand,
  dealerShouldHit,
  handTotal,
  isBlackjack,
  isBust,
  isLegalAction,
  isPair,
  isPairOfAces,
  isResolved,
  legalActions,
  type Action,
  type Hand,
  type LegalActionContext,
} from '../src/hand.js';
import { VEGAS_STRIP, type RuleSet } from '../src/rules.js';

// --- helpers ---------------------------------------------------------------

/**
 * Build cards from compact specs: `cards('AS', 'TD')` or `cards('A', '7')`.
 * A bare rank gets a rotating suit so ids stay distinct within a hand; suits
 * are irrelevant to every function under test.
 */
function cards(...specs: readonly string[]): Card[] {
  return specs.map((spec, i) => {
    const rank = spec.slice(0, 1) as Rank;
    const suit = (spec.length > 1 ? spec.slice(1, 2) : SUITS[i % SUITS.length]) as Suit;
    return { rank, suit, id: `${rank}${suit}#${i}` };
  });
}

const DEFAULT_BET = 10;

function makeHand(specs: readonly string[], overrides: Partial<Hand> = {}): Hand {
  return { ...createHand(cards(...specs), DEFAULT_BET), ...overrides };
}

function ctx(overrides: Partial<LegalActionContext> = {}): LegalActionContext {
  return { rules: VEGAS_STRIP, handCount: 1, availableFunds: 1000, ...overrides };
}

const H17: RuleSet = { ...VEGAS_STRIP, dealerHitsSoft17: true };
const NO_DAS: RuleSet = { ...VEGAS_STRIP, doubleAfterSplit: false };
const RESPLIT_ACES: RuleSet = { ...VEGAS_STRIP, resplitAces: true };
const WITH_SURRENDER: RuleSet = { ...VEGAS_STRIP, surrender: true };

const ALL_ACTIONS: readonly Action[] = ['hit', 'stand', 'double', 'split', 'surrender'];

/**
 * Independent reference implementation: brute-force every ace assignment
 * (each ace is 1 or 11) instead of the demote-as-needed loop the source uses.
 * The whole point of the property tests below is that this is a *different*
 * algorithm arriving at the same answer.
 */
function achievableTotals(hand: readonly Card[]): number[] {
  const base = hand.reduce((sum, c) => sum + (c.rank === 'A' ? 1 : cardValue(c.rank)), 0);
  const aces = hand.filter((c) => c.rank === 'A').length;
  const totals: number[] = [];
  for (let high = 0; high <= aces; high++) totals.push(base + 10 * high);
  return totals;
}

function bruteForceTotal(hand: readonly Card[]): { total: number; soft: boolean } {
  const totals = achievableTotals(hand);
  const hardTotal = totals[0] as number; // every ace counted as 1
  let best = -1;
  let bestUsedHighAce = false;
  totals.forEach((total, highAces) => {
    if (total <= 21 && total > best) {
      best = total;
      bestUsedHighAce = highAces > 0;
    }
  });
  if (best < 0) return { total: hardTotal, soft: false };
  return { total: best, soft: bestUsedHighAce };
}

/** All rank multisets of exactly `size` cards — order-insensitive, so no blowup. */
function rankCombinations(size: number): Rank[][] {
  const out: Rank[][] = [];
  const walk = (start: number, acc: Rank[]): void => {
    if (acc.length === size) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < RANKS.length; i++) {
      const rank = RANKS[i];
      if (rank === undefined) continue;
      acc.push(rank);
      walk(i, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

// --- handTotal -------------------------------------------------------------

describe('handTotal', () => {
  describe('hard totals', () => {
    it.each([
      { specs: ['T', '7'], total: 17 },
      { specs: ['9', '7'], total: 16 },
      { specs: ['2', '3'], total: 5 },
      { specs: ['K', 'Q'], total: 20 },
      { specs: ['5', '6', '6'], total: 17 },
    ])('$specs totals $total hard', ({ specs, total }) => {
      expect(handTotal(cards(...specs))).toEqual({ total, soft: false });
    });

    it('reports the busted hard total for T,9,5', () => {
      expect(handTotal(cards('T', '9', '5'))).toEqual({ total: 24, soft: false });
      expect(isBust(cards('T', '9', '5'))).toBe(true);
    });
  });

  describe('soft totals', () => {
    it.each([
      { specs: ['A', '7'], total: 18 },
      { specs: ['A', '2'], total: 13 },
      { specs: ['A', 'T'], total: 21 },
      { specs: ['A', '2', '5'], total: 18 },
    ])('$specs totals $total soft', ({ specs, total }) => {
      expect(handTotal(cards(...specs))).toEqual({ total, soft: true });
    });

    it('demotes the ace when the soft total would bust: A,6,T is a hard 17', () => {
      expect(handTotal(cards('A', '6', 'T'))).toEqual({ total: 17, soft: false });
    });

    it('demotes on the drawn card that pushes past 21: A,5 soft 16 becomes hard 16', () => {
      expect(handTotal(cards('A', '5'))).toEqual({ total: 16, soft: true });
      expect(handTotal(cards('A', '5', 'T'))).toEqual({ total: 16, soft: false });
    });
  });

  describe('multiple aces', () => {
    it.each([
      { specs: ['A', 'A'], total: 12, soft: true },
      { specs: ['A', 'A', '9'], total: 21, soft: true },
      { specs: ['A', 'A', '9', 'T'], total: 21, soft: false },
      { specs: ['A', 'A', 'A', 'A'], total: 14, soft: true },
      { specs: ['A', 'A', 'A'], total: 13, soft: true },
      { specs: ['A', 'A', 'T', 'T'], total: 22, soft: false },
    ])('$specs totals $total (soft: $soft)', ({ specs, total, soft }) => {
      expect(handTotal(cards(...specs))).toEqual({ total, soft });
    });

    it('never counts more than one ace as 11', () => {
      const { total, soft } = handTotal(cards('A', 'A', 'A', 'A', '7'));
      expect(soft).toBe(true);
      expect(total).toBe(21); // 11 + 1 + 1 + 1 + 7
    });
  });

  describe('property: agreement with brute-forced ace assignments', () => {
    it.each([2, 3, 4, 5])('holds for every %i-card rank combination', (size) => {
      for (const ranks of rankCombinations(size)) {
        const hand = cards(...ranks);
        const actual = handTotal(hand);
        const expected = bruteForceTotal(hand);
        const totals = achievableTotals(hand);
        const label = ranks.join(',');

        // The engine's answer must be the brute-forced answer.
        expect(actual, label).toEqual(expected);

        // No hand can total less than one point per card.
        expect(actual.total, label).toBeGreaterThanOrEqual(hand.length);

        if (actual.soft) {
          // A soft total always has an ace counted as 11 alongside >= 1 other point.
          expect(actual.total, label).toBeGreaterThanOrEqual(12);
          expect(actual.total, label).toBeLessThanOrEqual(21);
          // Demoting that ace must land on a genuinely reachable hard total.
          expect(totals, label).toContain(actual.total - 10);
          expect(actual.total - 10, label).toBeLessThanOrEqual(21);
          // Soft means the maximum reachable total <= 21 was chosen.
          expect(actual.total, label).toBe(Math.max(...totals.filter((t) => t <= 21)));
        } else if (actual.total <= 21) {
          // Hard and live: every ace counted low, and no higher total fits.
          expect(actual.total, label).toBe(totals[0]);
          expect(totals.filter((t) => t <= 21), label).toEqual([actual.total]);
        } else {
          // Busted: no assignment at all keeps the hand alive.
          expect(totals.every((t) => t > 21), label).toBe(true);
          expect(actual.total, label).toBe(totals[0]);
        }

        expect(isBust(hand), label).toBe(actual.total > 21);
      }
    });
  });
});

// --- isBlackjack -----------------------------------------------------------

describe('isBlackjack', () => {
  it.each([
    ['AS', 'TD'],
    ['A', 'K'],
    ['QH', 'AC'],
  ])('is true for the two-card natural %s %s', (a, b) => {
    expect(isBlackjack(cards(a, b))).toBe(true);
  });

  it('is false for a two-card 21 that is not two cards', () => {
    expect(isBlackjack(cards('7', '7', '7'))).toBe(false);
    expect(isBlackjack(cards('A', '5', '5'))).toBe(false);
  });

  it.each([
    ['T', '9'],
    ['A', '9'],
    ['K', 'Q'],
  ])('is false for %s %s (not 21)', (a, b) => {
    expect(isBlackjack(cards(a, b))).toBe(false);
  });

  it('is false for 21 on a split ace — a natural cannot be made by splitting (SPEC §2)', () => {
    expect(isBlackjack(cards('A', 'T'), true)).toBe(false);
    expect(isBlackjack(cards('A', 'T'), false)).toBe(true);
  });

  it('is false for a single card', () => {
    expect(isBlackjack(cards('A'))).toBe(false);
  });
});

// --- isPair / isPairOfAces -------------------------------------------------

describe('isPair', () => {
  it.each([
    { specs: ['T', 'T'], expected: true },
    { specs: ['K', 'Q'], expected: true }, // equal value: splittable at Vegas Strip
    { specs: ['JS', 'TD'], expected: true },
    { specs: ['A', 'A'], expected: true },
    { specs: ['8', '8'], expected: true },
    { specs: ['T', '9'], expected: false },
    { specs: ['A', 'T'], expected: false },
    { specs: ['7', '7', '7'], expected: false }, // three cards is never a pair
    { specs: ['8'], expected: false },
    { specs: [], expected: false },
  ])('$specs -> $expected', ({ specs, expected }) => {
    expect(isPair(cards(...specs))).toBe(expected);
  });
});

describe('isPairOfAces', () => {
  it.each([
    { specs: ['A', 'A'], expected: true },
    { specs: ['AS', 'AH'], expected: true },
    { specs: ['T', 'T'], expected: false },
    { specs: ['A', 'T'], expected: false },
    { specs: ['A', 'A', 'A'], expected: false },
  ])('$specs -> $expected', ({ specs, expected }) => {
    expect(isPairOfAces(cards(...specs))).toBe(expected);
  });
});

// --- legalActions ----------------------------------------------------------

describe('legalActions under VEGAS_STRIP', () => {
  it('offers stand, hit and double on a fresh two-card hard 16 with ample funds', () => {
    const actions = legalActions(makeHand(['T', '6']), ctx());
    expect(new Set(actions)).toEqual(new Set<Action>(['stand', 'hit', 'double']));
    expect(actions).not.toContain('split');
  });

  it('offers double on any first two cards', () => {
    for (const specs of [['2', '3'], ['A', '2'], ['9', '9'], ['T', '9']]) {
      expect(legalActions(makeHand(specs), ctx())).toContain('double');
    }
  });

  describe('resolved hands offer nothing', () => {
    it.each([
      { name: 'a two-card natural', hand: makeHand(['A', 'T']) },
      { name: 'a hard 21', hand: makeHand(['T', '7', '4']) },
      { name: 'a soft 21', hand: makeHand(['A', '5', '5']) },
      { name: 'a 21 built from a split', hand: makeHand(['A', 'T'], { fromSplit: true }) },
      { name: 'a busted hand', hand: makeHand(['T', '9', '5']) },
      { name: 'a busted soft-turned-hard hand', hand: makeHand(['A', 'T', 'T', '5']) },
      { name: 'a stood hand', hand: makeHand(['T', '6'], { stood: true }) },
      { name: 'a doubled hand', hand: makeHand(['5', '6', '7'], { doubled: true }) },
      { name: 'a surrendered hand', hand: makeHand(['T', '6'], { surrendered: true }) },
    ])('$name', ({ hand }) => {
      expect(isResolved(hand)).toBe(true);
      expect(legalActions(hand, ctx())).toEqual([]);
    });
  });

  it('drops double and split once a third card arrives, keeping hit and stand', () => {
    const afterHit = makeHand(['8', '8', '2']); // was a splittable pair before the hit
    expect(new Set(legalActions(afterHit, ctx()))).toEqual(new Set<Action>(['stand', 'hit']));
  });

  describe('funds', () => {
    it('removes double and split when the bet cannot be matched', () => {
      const pair = makeHand(['8', '8']);
      const actions = legalActions(pair, ctx({ availableFunds: DEFAULT_BET - 1 }));
      expect(new Set(actions)).toEqual(new Set<Action>(['stand', 'hit']));
    });

    it('allows double and split on exactly enough funds', () => {
      const pair = makeHand(['8', '8']);
      const actions = legalActions(pair, ctx({ availableFunds: DEFAULT_BET }));
      expect(actions).toContain('double');
      expect(actions).toContain('split');
    });
  });

  describe('split limit', () => {
    it.each([1, 2, 3])('allows splitting a pair while holding %i hand(s)', (handCount) => {
      expect(legalActions(makeHand(['8', '8']), ctx({ handCount }))).toContain('split');
    });

    it('refuses to split at the four-hand maximum', () => {
      expect(legalActions(makeHand(['8', '8']), ctx({ handCount: 4 }))).not.toContain('split');
      expect(VEGAS_STRIP.maxHands).toBe(4);
    });

    it('does not offer split on a non-pair', () => {
      expect(legalActions(makeHand(['T', '9']), ctx())).not.toContain('split');
    });

    it('offers split on mixed ten-value cards (K,Q is a pair by value)', () => {
      expect(legalActions(makeHand(['K', 'Q']), ctx())).toContain('split');
    });
  });

  describe('double after split', () => {
    it('is allowed under VEGAS_STRIP (DAS)', () => {
      const postSplit = makeHand(['T', '6'], { fromSplit: true });
      expect(VEGAS_STRIP.doubleAfterSplit).toBe(true);
      expect(legalActions(postSplit, ctx())).toContain('double');
    });

    it('is not allowed when the rule set turns DAS off', () => {
      const postSplit = makeHand(['T', '6'], { fromSplit: true });
      const actions = legalActions(postSplit, ctx({ rules: NO_DAS }));
      expect(actions).not.toContain('double');
      expect(new Set(actions)).toEqual(new Set<Action>(['stand', 'hit']));
    });
  });

  describe('split aces', () => {
    it('gives a split ace holding its one card no actions at all (SPEC §2)', () => {
      const splitAce = makeHand(['A', '7'], { fromSplit: true, fromSplitAces: true });
      expect(legalActions(splitAce, ctx())).toEqual([]);
      expect(isResolved(splitAce)).toBe(true);
    });

    it('gives a split ace dealt a ten no actions, and it is not a blackjack', () => {
      const splitAce = makeHand(['A', 'T'], { fromSplit: true, fromSplitAces: true });
      expect(legalActions(splitAce, ctx())).toEqual([]);
      expect(isBlackjack(splitAce.cards, splitAce.fromSplit)).toBe(false);
    });

    it('does not allow resplitting aces under VEGAS_STRIP', () => {
      const acesAgain = makeHand(['A', 'A'], { fromSplit: true });
      expect(VEGAS_STRIP.resplitAces).toBe(false);
      expect(legalActions(acesAgain, ctx())).not.toContain('split');
    });

    it('allows resplitting aces when the rule set permits it', () => {
      const acesAgain = makeHand(['A', 'A'], { fromSplit: true });
      expect(legalActions(acesAgain, ctx({ rules: RESPLIT_ACES }))).toContain('split');
    });

    it('still allows the first split of aces', () => {
      expect(legalActions(makeHand(['A', 'A']), ctx())).toContain('split');
    });
  });

  describe('surrender', () => {
    it('is never offered under VEGAS_STRIP', () => {
      expect(VEGAS_STRIP.surrender).toBe(false);
      for (const ranks of rankCombinations(2)) {
        for (const handCount of [1, 4]) {
          const actions = legalActions(makeHand(ranks), ctx({ handCount }));
          expect(actions, ranks.join(',')).not.toContain('surrender');
        }
      }
    });

    it('is offered on a first decision when a rule set enables it', () => {
      expect(legalActions(makeHand(['T', '6']), ctx({ rules: WITH_SURRENDER }))).toContain(
        'surrender',
      );
      // ...but never after a split, nor after hitting.
      expect(
        legalActions(makeHand(['T', '6'], { fromSplit: true }), ctx({ rules: WITH_SURRENDER })),
      ).not.toContain('surrender');
      expect(
        legalActions(makeHand(['T', '4', '2']), ctx({ rules: WITH_SURRENDER })),
      ).not.toContain('surrender');
    });
  });

  it('returns actions in a stable order with no duplicates', () => {
    for (const ranks of rankCombinations(2)) {
      const actions = legalActions(makeHand(ranks), ctx());
      expect(new Set(actions).size, ranks.join(',')).toBe(actions.length);
      expect(actions.every((a) => ALL_ACTIONS.includes(a)), ranks.join(',')).toBe(true);
    }
  });
});

// --- state machine invariant ----------------------------------------------

describe('state machine invariant: no illegal action is ever accepted', () => {
  const contexts: LegalActionContext[] = [
    ctx(),
    ctx({ handCount: 4 }),
    ctx({ availableFunds: 0 }),
    ctx({ availableFunds: DEFAULT_BET }),
    ctx({ rules: NO_DAS }),
    ctx({ rules: RESPLIT_ACES }),
    ctx({ rules: WITH_SURRENDER }),
    ctx({ rules: H17 }),
  ];

  const variants: Partial<Hand>[] = [
    {},
    { fromSplit: true },
    { fromSplit: true, fromSplitAces: true },
    { stood: true },
    { doubled: true },
    { surrendered: true },
  ];

  it('isLegalAction agrees with legalActions for every action across a broad sample', () => {
    const rankSets = [...rankCombinations(2), ...rankCombinations(3)];
    for (const ranks of rankSets) {
      for (const variant of variants) {
        const hand = makeHand(ranks, variant);
        for (const context of contexts) {
          const legal = legalActions(hand, context);
          for (const action of ALL_ACTIONS) {
            expect(isLegalAction(hand, action, context), `${ranks.join(',')} ${action}`).toBe(
              legal.includes(action),
            );
          }
        }
      }
    }
  });

  it('never offers any action on a resolved hand, whatever the context', () => {
    const rankSets = [...rankCombinations(2), ...rankCombinations(3)];
    for (const ranks of rankSets) {
      for (const variant of variants) {
        const hand = makeHand(ranks, variant);
        if (!isResolved(hand)) continue;
        for (const context of contexts) {
          expect(legalActions(hand, context), ranks.join(',')).toEqual([]);
        }
      }
    }
  });

  it('always offers stand, and offers hit only below 21, on an unresolved hand', () => {
    const rankSets = [...rankCombinations(2), ...rankCombinations(3)];
    for (const ranks of rankSets) {
      for (const variant of variants) {
        const hand = makeHand(ranks, variant);
        if (isResolved(hand)) continue;
        const actions = legalActions(hand, ctx());
        expect(actions, ranks.join(',')).toContain('stand');
        expect(actions.includes('hit'), ranks.join(',')).toBe(handTotal(hand.cards).total < 21);
      }
    }
  });

  it('only ever offers double or split as a first decision on exactly two cards', () => {
    for (const ranks of rankCombinations(3)) {
      for (const variant of variants) {
        const actions = legalActions(makeHand(ranks, variant), ctx());
        expect(actions, ranks.join(',')).not.toContain('double');
        expect(actions, ranks.join(',')).not.toContain('split');
      }
    }
  });

  it('only ever offers split on a pair', () => {
    for (const ranks of rankCombinations(2)) {
      for (const context of contexts) {
        const hand = makeHand(ranks);
        if (legalActions(hand, context).includes('split')) {
          expect(isPair(hand.cards), ranks.join(',')).toBe(true);
        }
      }
    }
  });
});

// --- dealerShouldHit -------------------------------------------------------

describe('dealerShouldHit', () => {
  describe('S17 (VEGAS_STRIP)', () => {
    it.each([
      { specs: ['2', '3'], label: 'hard 5', expected: true },
      { specs: ['T', '2'], label: 'hard 12', expected: true },
      { specs: ['T', '6'], label: 'hard 16', expected: true },
      { specs: ['9', '7'], label: 'hard 16', expected: true },
      { specs: ['A', '5'], label: 'soft 16', expected: true },
      { specs: ['T', '7'], label: 'hard 17', expected: false },
      { specs: ['9', '5', '3'], label: 'hard 17', expected: false },
      { specs: ['A', '6'], label: 'soft 17', expected: false },
      { specs: ['A', '2', '4'], label: 'soft 17 (three cards)', expected: false },
      { specs: ['A', '7'], label: 'soft 18', expected: false },
      { specs: ['A', '9'], label: 'soft 20', expected: false },
      { specs: ['A', 'A', '9'], label: 'soft 21', expected: false },
      { specs: ['T', '8'], label: 'hard 18', expected: false },
      { specs: ['A', '6', 'T'], label: 'demoted hard 17', expected: false },
      { specs: ['A', '5', 'T'], label: 'demoted hard 16', expected: true },
    ])('$label $specs -> hit: $expected', ({ specs, expected }) => {
      expect(dealerShouldHit(cards(...specs), VEGAS_STRIP)).toBe(expected);
    });

    it('stands on soft 17, which is the whole point of S17', () => {
      expect(VEGAS_STRIP.dealerHitsSoft17).toBe(false);
      expect(handTotal(cards('A', '6'))).toEqual({ total: 17, soft: true });
      expect(dealerShouldHit(cards('A', '6'), VEGAS_STRIP)).toBe(false);
    });
  });

  describe('H17 variant', () => {
    it.each([
      { specs: ['A', '6'], label: 'soft 17', expected: true },
      { specs: ['A', '2', '4'], label: 'soft 17 (three cards)', expected: true },
      { specs: ['T', '7'], label: 'hard 17', expected: false },
      { specs: ['A', '7'], label: 'soft 18', expected: false },
      { specs: ['A', '6', 'T'], label: 'demoted hard 17', expected: false },
      { specs: ['T', '6'], label: 'hard 16', expected: true },
    ])('$label $specs -> hit: $expected', ({ specs, expected }) => {
      expect(dealerShouldHit(cards(...specs), H17)).toBe(expected);
    });
  });

  it('agrees with a direct reading of the total for every two-card dealer hand', () => {
    for (const ranks of rankCombinations(2)) {
      const hand = cards(...ranks);
      const { total, soft } = handTotal(hand);
      const label = ranks.join(',');
      expect(dealerShouldHit(hand, VEGAS_STRIP), label).toBe(total < 17);
      expect(dealerShouldHit(hand, H17), label).toBe(total < 17 || (total === 17 && soft));
    }
  });

  it('never hits a busted or 21 hand', () => {
    for (const rules of [VEGAS_STRIP, H17]) {
      expect(dealerShouldHit(cards('T', '9', '5'), rules)).toBe(false);
      expect(dealerShouldHit(cards('A', 'T'), rules)).toBe(false);
      expect(dealerShouldHit(cards('7', '7', '7'), rules)).toBe(false);
    }
  });
});
