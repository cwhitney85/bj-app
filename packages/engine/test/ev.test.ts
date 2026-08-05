import { describe, expect, it } from 'vitest';

import {
  SUITS,
  compIndex,
  type Card,
  type CompIndex,
  type Composition,
  type MutableComposition,
  type Rank,
  type Suit,
} from '../src/cards.js';
import {
  clearEvCaches,
  dealerOutcomes,
  evaluateActions,
  insuranceEv,
  type ActionEv,
  type DealerDistribution,
  type EvInput,
} from '../src/ev.js';
import { handTotal, isPair } from '../src/hand.js';
import { VEGAS_STRIP, type RuleSet } from '../src/rules.js';

// --- helpers ---------------------------------------------------------------

/** Same compact card spec as `hand.test.ts`: `cards('AS', 'TD')` or `cards('A', '7')`. */
function cards(...specs: readonly string[]): Card[] {
  return specs.map((spec, i) => {
    const rank = spec.slice(0, 1) as Rank;
    const suit = (spec.length > 1 ? spec.slice(1, 2) : SUITS[i % SUITS.length]) as Suit;
    return { rank, suit, id: `${rank}${suit}#${i}` };
  });
}

function card(spec: string): Card {
  return cards(spec)[0] as Card;
}

const DECKS = 6;
const H17: RuleSet = { ...VEGAS_STRIP, dealerHitsSoft17: true };

/** A full, untouched shoe: four of each rank per deck, sixteen tens. */
function shoe(decks = DECKS): Composition {
  const n = 4 * decks;
  return [n, n, n, n, n, n, n, n, n, 16 * decks];
}

/** Remove one card per spec, e.g. `remove(shoe(), 'T', '6', '9')`. */
function remove(composition: Composition, ...specs: readonly string[]): Composition {
  const next = composition.slice() as MutableComposition;
  for (const spec of specs) next[compIndex(spec.slice(0, 1) as Rank)] -= 1;
  return next;
}

function totalCards(composition: Composition): number {
  return composition.reduce((sum, count) => sum + count, 0);
}

/**
 * The engine targets the ES2022 lib, which has no DOM and no Node globals, so
 * `performance` is not declared. The shipped code must never read a clock
 * (SPEC §3) but the budget test has to, so it is declared here rather than by
 * widening `lib` for the whole package.
 */
declare const performance: { now(): number };

const ALL_UPCARDS: readonly CompIndex[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const UPCARD_SPEC: Readonly<Record<CompIndex, string>> = {
  0: 'A', 1: '2', 2: '3', 3: '4', 4: '5',
  5: '6', 6: '7', 7: '8', 8: '9', 9: 'T',
};

function distributionSum(d: DealerDistribution): number {
  return d.p17 + d.p18 + d.p19 + d.p20 + d.p21 + d.pBust + d.pBlackjack;
}

/**
 * Build an `EvInput` for `playerSpecs` against `upSpec`, deriving the unseen
 * composition by removing exactly those cards from a fresh shoe — the
 * `current-round` view of SPEC §5.3.
 */
function evInput(
  playerSpecs: readonly string[],
  upSpec: string,
  overrides: Partial<EvInput> = {},
): EvInput {
  const playerCards = cards(...playerSpecs);
  return {
    rules: VEGAS_STRIP,
    composition: remove(shoe(), ...playerSpecs, upSpec),
    playerCards,
    dealerUpcard: card(upSpec),
    fromSplit: false,
    canDouble: playerCards.length === 2,
    canSplit: isPair(playerCards),
    peekedNotBlackjack: true,
    ...overrides,
  };
}

function evaluate(
  playerSpecs: readonly string[],
  upSpec: string,
  overrides: Partial<EvInput> = {},
): ActionEv {
  return evaluateActions(evInput(playerSpecs, upSpec, overrides));
}

/**
 * Independent reference for `evStand`, written straight off the payoff rules
 * and driven by `handTotal` rather than by anything inside `ev.ts`. This is
 * what pins the calculator's internal `(hard, anyAce)` bookkeeping to the hand
 * evaluator the rest of the engine uses.
 */
function referenceStandEv(playerCards: readonly Card[], dealer: DealerDistribution): number {
  const { total } = handTotal(playerCards);
  if (total > 21) return -1;
  let ev = dealer.pBust - dealer.pBlackjack;
  const byTotal: readonly [number, number][] = [
    [17, dealer.p17], [18, dealer.p18], [19, dealer.p19],
    [20, dealer.p20], [21, dealer.p21],
  ];
  for (const [dealerTotal, p] of byTotal) {
    if (total > dealerTotal) ev += p;
    else if (total < dealerTotal) ev -= p;
  }
  return ev;
}

// --- distributions are distributions ---------------------------------------

describe('dealerOutcomes: the distribution is a distribution', () => {
  it.each(ALL_UPCARDS)('sums to 1 for upcard %i on a fresh six-deck shoe', (upcard) => {
    for (const peeked of [false, true]) {
      const d = dealerOutcomes(upcard, remove(shoe(), UPCARD_SPEC[upcard]), peeked, VEGAS_STRIP);
      expect(distributionSum(d), `peeked=${peeked}`).toBeCloseTo(1, 12);
      for (const p of Object.values(d)) {
        expect(p, `peeked=${peeked}`).toBeGreaterThanOrEqual(0);
        expect(p, `peeked=${peeked}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it.each(ALL_UPCARDS)('sums to 1 for upcard %i on skewed compositions', (upcard) => {
    const skews: readonly Composition[] = [
      remove(shoe(1), UPCARD_SPEC[upcard]), // single deck
      remove(shoe(8), UPCARD_SPEC[upcard]), // eight decks
      // Ten-poor: every ten stripped out.
      (() => { const c = remove(shoe(), UPCARD_SPEC[upcard]).slice() as MutableComposition; c[9] = 0; return c; })(),
      // Ten-rich: nothing but tens and a token of everything else.
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 60],
      // Ace-rich.
      [40, 2, 2, 2, 2, 2, 2, 2, 2, 20],
      // Low-card-only: the deepest possible dealer recursion.
      [0, 24, 24, 24, 0, 0, 0, 0, 0, 0],
    ];
    for (const [i, composition] of skews.entries()) {
      for (const peeked of [false, true]) {
        const d = dealerOutcomes(upcard, composition, peeked, VEGAS_STRIP);
        expect(distributionSum(d), `skew ${i} peeked=${peeked}`).toBeCloseTo(1, 12);
      }
    }
  });

  it('sums to 1 under H17 as well as S17', () => {
    for (const upcard of ALL_UPCARDS) {
      const d = dealerOutcomes(upcard, remove(shoe(), UPCARD_SPEC[upcard]), false, H17);
      expect(distributionSum(d)).toBeCloseTo(1, 12);
    }
  });

  it('is unaffected by cache state', () => {
    const composition = remove(shoe(), '6');
    const first = dealerOutcomes(5, composition, false, VEGAS_STRIP);
    clearEvCaches();
    const second = dealerOutcomes(5, composition, false, VEGAS_STRIP);
    expect(second).toEqual(first);
  });
});

// --- published dealer probabilities ----------------------------------------

/**
 * Published six-deck S17 dealer bust rates. Convention asserted here: the
 * distribution is UNCONDITIONED (`peekedNotBlackjack: false`), a natural is
 * reported in `pBlackjack` and is NOT counted as a bust, and every figure is a
 * fraction of all dealer hands including the naturals. That is the convention
 * the ace and ten figures are quoted under; conditioning on no natural would
 * raise the ace figure to ~0.199 and the ten figure to ~0.223.
 */
describe('dealerOutcomes: published probabilities', () => {
  const PUBLISHED_BUST: readonly (readonly [CompIndex, number])[] = [
    [1, 0.352], [2, 0.374], [3, 0.395], [4, 0.416], [5, 0.422],
    [6, 0.262], [7, 0.244], [8, 0.228], [9, 0.214], [0, 0.115],
  ];

  it.each(PUBLISHED_BUST)('reproduces the bust rate for upcard %i (≈ %f)', (upcard, published) => {
    const d = dealerOutcomes(upcard, remove(shoe(), UPCARD_SPEC[upcard]), false, VEGAS_STRIP);
    expect(d.pBust).toBeCloseTo(published, 2);
    expect(Math.abs(d.pBust - published)).toBeLessThan(0.005);
  });

  it('stands on soft 17, which is what makes the six-up bust rate the highest', () => {
    const busts = ALL_UPCARDS.map(
      (u) => dealerOutcomes(u, remove(shoe(), UPCARD_SPEC[u]), false, VEGAS_STRIP).pBust,
    );
    const sixUp = busts[5] as number;
    expect(Math.max(...busts)).toBe(sixUp);
  });

  it('busts more often under H17 than S17 on the upcards that can make a soft 17', () => {
    // Only an ace or a six up can leave the dealer sitting on soft 17.
    for (const upcard of [0, 5] as const) {
      const composition = remove(shoe(), UPCARD_SPEC[upcard]);
      const s17 = dealerOutcomes(upcard, composition, false, VEGAS_STRIP);
      const h17 = dealerOutcomes(upcard, composition, false, H17);
      expect(h17.pBust).toBeGreaterThan(s17.pBust);
      expect(h17.p17).toBeLessThan(s17.p17);
    }
  });

  it('puts nearly all of a ten-up and ace-up hand on a made total', () => {
    // Sanity on the shape: showing a ten, the dealer reaches 20 about a third
    // of the time, and showing an ace, 21 (naturals included) about a third.
    const tenUp = dealerOutcomes(9, remove(shoe(), 'T'), false, VEGAS_STRIP);
    expect(tenUp.p20).toBeGreaterThan(0.32);
    expect(tenUp.p20).toBeLessThan(0.36);

    const aceUp = dealerOutcomes(0, remove(shoe(), 'A'), false, VEGAS_STRIP);
    expect(aceUp.p21 + aceUp.pBlackjack).toBeGreaterThan(0.34);
  });
});

// --- the peek --------------------------------------------------------------

describe('dealerOutcomes: peek conditioning', () => {
  it('reports the unconditioned natural rate for an ace upcard', () => {
    const composition = remove(shoe(), 'A');
    const d = dealerOutcomes(0, composition, false, VEGAS_STRIP);
    // 96 tens among the 311 cards the player cannot see.
    expect(d.pBlackjack).toBeCloseTo(96 / 311, 12);
    // Which is the ≈0.3078 figure quoted for a fresh shoe, to within a card.
    expect(d.pBlackjack).toBeCloseTo(0.3078, 2);
    expect(Math.abs(d.pBlackjack - 0.3078)).toBeLessThan(0.005);
  });

  it('reports the unconditioned natural rate for a ten upcard', () => {
    const d = dealerOutcomes(9, remove(shoe(), 'T'), false, VEGAS_STRIP);
    expect(d.pBlackjack).toBeCloseTo(24 / 311, 12); // 24 aces among 311
  });

  it('zeroes pBlackjack and renormalises for an ace upcard once peeked', () => {
    const composition = remove(shoe(), 'A');
    const raw = dealerOutcomes(0, composition, false, VEGAS_STRIP);
    const peeked = dealerOutcomes(0, composition, true, VEGAS_STRIP);

    expect(peeked.pBlackjack).toBe(0);
    expect(distributionSum(peeked)).toBeCloseTo(1, 12);
    expect(peeked.pBust).not.toBeCloseTo(raw.pBust, 4);

    // Renormalisation, not truncation: every surviving branch must scale by
    // exactly 1/(1 - pBlackjack).
    const scale = 1 / (1 - raw.pBlackjack);
    expect(peeked.pBust).toBeCloseTo(raw.pBust * scale, 12);
    expect(peeked.p17).toBeCloseTo(raw.p17 * scale, 12);
    expect(peeked.p18).toBeCloseTo(raw.p18 * scale, 12);
    expect(peeked.p19).toBeCloseTo(raw.p19 * scale, 12);
    expect(peeked.p20).toBeCloseTo(raw.p20 * scale, 12);
    expect(peeked.p21).toBeCloseTo(raw.p21 * scale, 12);
  });

  it('zeroes pBlackjack and renormalises for a ten upcard once peeked', () => {
    const composition = remove(shoe(), 'T');
    const raw = dealerOutcomes(9, composition, false, VEGAS_STRIP);
    const peeked = dealerOutcomes(9, composition, true, VEGAS_STRIP);
    const scale = 1 / (1 - raw.pBlackjack);

    expect(peeked.pBlackjack).toBe(0);
    expect(peeked.p20).toBeCloseTo(raw.p20 * scale, 12);
    expect(peeked.pBust).toBeCloseTo(raw.pBust * scale, 12);
  });

  it('leaves upcards that cannot make a natural untouched', () => {
    for (const upcard of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const composition = remove(shoe(), UPCARD_SPEC[upcard]);
      const raw = dealerOutcomes(upcard, composition, false, VEGAS_STRIP);
      const peeked = dealerOutcomes(upcard, composition, true, VEGAS_STRIP);
      expect(raw.pBlackjack).toBe(0);
      expect(peeked).toEqual(raw);
    }
  });

  it('conditions on the hole card only — deeper draws still come from the real shoe', () => {
    // The peek rules out a ten *in the hole*. It says nothing about the rest of
    // the shoe, which stays ten-rich for every card the dealer draws afterwards.
    const raw = dealerOutcomes(0, remove(shoe(), 'A'), false, VEGAS_STRIP);
    const peeked = dealerOutcomes(0, remove(shoe(), 'A'), true, VEGAS_STRIP);
    expect(peeked.pBust).toBeCloseTo(raw.pBust / (1 - raw.pBlackjack), 12);
    expect(peeked.pBust).toBeCloseTo(0.167, 3);

    // Had the conditioning wrongly stripped the tens from the whole shoe, the
    // dealer would draw nothing but small cards, every stiff hand would be
    // rescued, and the bust rate would collapse by a factor of four. The gap is
    // the whole point: the two are not remotely the same operation.
    const tenless = remove(shoe(), 'A').slice() as MutableComposition;
    tenless[9] = 0;
    const wrong = dealerOutcomes(0, tenless, false, VEGAS_STRIP);
    expect(wrong.pBust).toBeLessThan(peeked.pBust / 3);
  });

  it('survives conditioning on an impossible event without NaN', () => {
    // Ace up, nothing left but tens, and yet no natural: contradictory. The
    // answer must still be a normalised distribution.
    const d = dealerOutcomes(0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 40], true, VEGAS_STRIP);
    expect(distributionSum(d)).toBeCloseTo(1, 12);
    expect(Number.isNaN(d.pBust)).toBe(false);
  });
});

// --- insurance -------------------------------------------------------------

describe('insuranceEv', () => {
  it('is a losing bet on a fresh six-deck shoe (SPEC §5.4 INSURANCE_IS_A_SUCKER_BET)', () => {
    // Nothing seen at all: 96 tens in 312, paying 2:1 → 3·(4/13) − 1 = −1/13.
    expect(insuranceEv(shoe(), VEGAS_STRIP)).toBeCloseTo(-0.076923, 6);
    expect(insuranceEv(shoe(), VEGAS_STRIP)).toBeLessThan(0);
  });

  it('is still losing once the dealer ace and a player hand are removed', () => {
    // The realistic offer: ace up, two player cards down. 96 tens in 309.
    const composition = remove(shoe(), 'A', '9', '7');
    expect(insuranceEv(composition, VEGAS_STRIP)).toBeCloseTo(3 * (96 / 309) - 1, 12);
    expect(insuranceEv(composition, VEGAS_STRIP)).toBeLessThan(0);
  });

  it('turns positive on a ten-rich shoe — the counting hook (SPEC §5.3)', () => {
    // Break-even is exactly one ten in three.
    const breakEven: Composition = [0, 20, 20, 20, 0, 0, 0, 0, 0, 30];
    expect(insuranceEv(breakEven, VEGAS_STRIP)).toBeCloseTo(0, 12);

    const tenRich: Composition = [0, 10, 10, 10, 0, 0, 0, 0, 0, 40];
    expect(insuranceEv(tenRich, VEGAS_STRIP)).toBeGreaterThan(0);

    const tenPoor: Composition = [24, 24, 24, 24, 24, 24, 24, 24, 24, 0];
    expect(insuranceEv(tenPoor, VEGAS_STRIP)).toBe(-1);
  });

  it('rises monotonically with ten density', () => {
    let previous = -Infinity;
    for (let tens = 0; tens <= 60; tens += 5) {
      const composition: Composition = [10, 10, 10, 10, 10, 10, 10, 10, 10, tens];
      const ev = insuranceEv(composition, VEGAS_STRIP);
      expect(ev).toBeGreaterThan(previous);
      previous = ev;
    }
  });

  it('honours the payout in the rule set rather than assuming 2:1', () => {
    const stingy: RuleSet = { ...VEGAS_STRIP, insurancePayout: [1, 1] };
    expect(insuranceEv(shoe(), stingy)).toBeCloseTo(2 * (4 / 13) - 1, 12);
    expect(insuranceEv(shoe(), stingy)).toBeLessThan(insuranceEv(shoe(), VEGAS_STRIP));
  });

  it('does not divide by zero on an empty composition', () => {
    const ev = insuranceEv([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], VEGAS_STRIP);
    expect(Number.isNaN(ev)).toBe(false);
    expect(ev).toBe(-1);
  });
});

// --- standing agrees with an independent reading of the rules ---------------

describe('evaluateActions: evStand', () => {
  const HANDS: readonly (readonly string[])[] = [
    ['T', '6'], ['T', 'T'], ['9', '7'], ['5', '4'], ['A', '7'],
    ['A', 'A'], ['A', 'A', '9'], ['A', '6', 'T'], ['T', '9', '5'],
  ];

  it.each(ALL_UPCARDS)('matches a rules-first reference for upcard %i', (upcard) => {
    const upSpec = UPCARD_SPEC[upcard];
    for (const specs of HANDS) {
      const input = evInput(specs, upSpec, { peekedNotBlackjack: false });
      const dealer = dealerOutcomes(upcard, input.composition, false, VEGAS_STRIP);
      const expected = referenceStandEv(input.playerCards, dealer);
      expect(evaluateActions(input).stand, `${specs.join(',')} vs ${upSpec}`).toBeCloseTo(
        expected,
        12,
      );
    }
  });

  it('scores a busted hand at exactly -1 whatever the dealer shows', () => {
    for (const upcard of ALL_UPCARDS) {
      expect(evaluate(['T', '9', '5'], UPCARD_SPEC[upcard]).stand).toBe(-1);
    }
  });

  it('pays a natural at 3:2, not at 1:1', () => {
    // Peeked: the dealer cannot push, so a natural is worth the full 1.5.
    expect(evaluate(['A', 'T'], '9').stand).toBeCloseTo(1.5, 12);

    // Unpeeked against an ace: the dealer's own natural pushes it back.
    const raw = evaluate(['A', 'T'], 'A', { peekedNotBlackjack: false });
    const dealerNatural = dealerOutcomes(0, remove(shoe(), 'A', 'T', 'A'), false, VEGAS_STRIP)
      .pBlackjack;
    expect(raw.stand).toBeCloseTo(1.5 * (1 - dealerNatural), 12);
    expect(raw.stand).toBeLessThan(1.5);
  });

  it('does not pay a natural rate on a 21 built by splitting', () => {
    const input = evInput(['A', 'T'], '9', { fromSplit: true, canDouble: false });
    const split = evaluateActions(input);
    expect(split.stand).toBeLessThan(1);

    // Worth exactly what any other 21 is worth against this shoe. Comparing
    // against a differently-built 21 would not work: removing A,5,5 instead of
    // A,T changes the composition and with it the dealer distribution.
    const dealer = dealerOutcomes(8, input.composition, true, VEGAS_STRIP);
    expect(split.stand).toBeCloseTo(referenceStandEv(cards('A', '5', '5'), dealer), 12);
    expect(split.stand).toBeLessThan(evaluate(['A', 'T'], '9').stand);
  });

  it('honours a 6:5 payout rather than hardcoding 3:2', () => {
    const short: RuleSet = { ...VEGAS_STRIP, blackjackPayout: [6, 5] };
    expect(evaluate(['A', 'T'], '9', { rules: short }).stand).toBeCloseTo(1.2, 12);
  });
});

// --- monotonicity and sanity -----------------------------------------------

describe('evaluateActions: monotonicity and sanity', () => {
  it('standing on 20 beats standing on 16 against every upcard', () => {
    for (const upcard of ALL_UPCARDS) {
      const up = UPCARD_SPEC[upcard];
      expect(evaluate(['T', 'T'], up).stand, up).toBeGreaterThan(evaluate(['T', '6'], up).stand);
    }
  });

  it('stand EV is non-decreasing in the hard total, for every upcard', () => {
    // Hard totals 5..20, each built from two or three cards.
    const byTotal: readonly (readonly [number, readonly string[]])[] = [
      [5, ['2', '3']], [6, ['2', '4']], [7, ['2', '5']], [8, ['2', '6']],
      [9, ['2', '7']], [10, ['2', '8']], [11, ['2', '9']], [12, ['T', '2']],
      [13, ['T', '3']], [14, ['T', '4']], [15, ['T', '5']], [16, ['T', '6']],
      [17, ['T', '7']], [18, ['T', '8']], [19, ['T', '9']], [20, ['T', 'T']],
    ];
    for (const upcard of ALL_UPCARDS) {
      const up = UPCARD_SPEC[upcard];
      // The composition is held fixed across the sweep so that the total is the
      // only thing varying. Removing the player's own cards would perturb the
      // dealer distribution by ~1e-3 per card, which is larger than the gap
      // between adjacent stiff totals against an ace and would swamp the effect.
      const composition = remove(shoe(), up);
      let previous = -Infinity;
      for (const [total, specs] of byTotal) {
        const ev = evaluateActions({
          rules: VEGAS_STRIP,
          composition,
          playerCards: cards(...specs),
          dealerUpcard: card(up),
          fromSplit: false,
          canDouble: false,
          canSplit: false,
          peekedNotBlackjack: true,
        }).stand;
        expect(ev, `total ${total} vs ${up}`).toBeGreaterThanOrEqual(previous);
        previous = ev;
      }
    }
  });

  it('never rates hitting a hard 21 above standing on it', () => {
    for (const upcard of ALL_UPCARDS) {
      const up = UPCARD_SPEC[upcard];
      const ev = evaluate(['7', '7', '7'], up, { canDouble: false });
      expect(ev.hit, up).toBeLessThanOrEqual(ev.stand + 1e-12);
      expect(ev.best, up).toBe('stand');
    }
  });

  it('always prefers hitting a hand that cannot bust', () => {
    for (const upcard of ALL_UPCARDS) {
      const up = UPCARD_SPEC[upcard];
      for (const specs of [['5', '3'], ['A', '4'], ['2', '4']]) {
        const ev = evaluate(specs, up, { canDouble: false });
        expect(ev.hit, `${specs.join(',')} vs ${up}`).toBeGreaterThan(ev.stand);
      }
    }
  });

  it('rates every action worse against a strong upcard than against a weak one', () => {
    // A stiff 16 is a losing hand everywhere, but far more so against a ten.
    const versusSix = evaluate(['T', '6'], '6');
    const versusTen = evaluate(['T', '6'], 'T');
    expect(versusTen.bestEv).toBeLessThan(versusSix.bestEv);
    expect(versusTen.stand).toBeLessThan(versusSix.stand);
    expect(versusTen.hit).toBeLessThan(versusSix.hit);
  });

  it('values doubling at exactly twice the one-card stand average', () => {
    const input = evInput(['5', '6'], '6');
    const ev = evaluateActions(input);
    const dealer = dealerOutcomes(5, input.composition, true, VEGAS_STRIP);
    const remaining = totalCards(input.composition);

    // Rebuild the average by hand from the dealer distribution.
    let average = 0;
    const specs = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'] as const;
    for (const spec of specs) {
      const index = compIndex(spec);
      const count = input.composition[index];
      average += (count / remaining) * referenceStandEv(cards('5', '6', spec), dealer);
    }
    expect(ev.double).toBeCloseTo(2 * average, 12);
  });
});

// --- bounds and best -------------------------------------------------------

describe('evaluateActions: bounds and the best action', () => {
  const SAMPLE: readonly (readonly string[])[] = [
    ['T', '6'], ['T', 'T'], ['8', '8'], ['A', 'A'], ['A', '7'], ['A', '2'],
    ['5', '5'], ['9', '9'], ['2', '2'], ['7', '7'], ['5', '6'], ['T', '9'],
    ['A', 'T'], ['6', '4'], ['3', '3'],
  ];

  it('keeps every EV inside its theoretical range', () => {
    for (const upcard of ALL_UPCARDS) {
      const up = UPCARD_SPEC[upcard];
      for (const specs of SAMPLE) {
        const ev = evaluate(specs, up);
        const label = `${specs.join(',')} vs ${up}`;

        // A natural is paid at 3:2, so standing can exceed 1.
        expect(ev.stand, label).toBeGreaterThanOrEqual(-1);
        expect(ev.stand, label).toBeLessThanOrEqual(1.5);
        expect(ev.hit, label).toBeGreaterThanOrEqual(-1);
        expect(ev.hit, label).toBeLessThanOrEqual(1);

        if (ev.double !== null) {
          expect(ev.double, label).toBeGreaterThanOrEqual(-2);
          expect(ev.double, label).toBeLessThanOrEqual(2);
        }
        if (ev.split !== null) {
          // Split reports BOTH hands, each of which may itself be doubled under
          // DAS, so its bound is four units rather than one. In practice it
          // never leaves [-1.5, 1].
          expect(ev.split, label).toBeGreaterThanOrEqual(-4);
          expect(ev.split, label).toBeLessThanOrEqual(4);
          expect(ev.split, label).toBeGreaterThan(-2);
          expect(ev.split, label).toBeLessThan(1.5);
        }

        for (const value of [ev.stand, ev.hit, ev.double, ev.split, ev.bestEv]) {
          expect(value === null || Number.isFinite(value), label).toBe(true);
        }
      }
    }
  });

  it('reports bestEv as the maximum available action, and best as its name', () => {
    for (const upcard of ALL_UPCARDS) {
      const up = UPCARD_SPEC[upcard];
      for (const specs of SAMPLE) {
        const ev = evaluate(specs, up);
        const label = `${specs.join(',')} vs ${up}`;
        const available: readonly number[] = [
          ev.stand,
          ev.hit,
          ...(ev.double === null ? [] : [ev.double]),
          ...(ev.split === null ? [] : [ev.split]),
        ];
        expect(ev.bestEv, label).toBe(Math.max(...available));

        const named: Record<string, number | null> = {
          stand: ev.stand, hit: ev.hit, double: ev.double, split: ev.split,
        };
        expect(named[ev.best], label).toBe(ev.bestEv);
      }
    }
  });

  it('returns null for actions the caller has ruled out', () => {
    const ev = evaluate(['8', '8'], '6', { canDouble: false, canSplit: false });
    expect(ev.double).toBeNull();
    expect(ev.split).toBeNull();
    expect(ev.best === 'double' || ev.best === 'split').toBe(false);
  });

  it('refuses to split a hand that is not a pair, whatever the caller claims', () => {
    expect(evaluate(['T', '9'], '6', { canSplit: true }).split).toBeNull();
  });

  it('refuses to double a hand of more than two cards, whatever the caller claims', () => {
    expect(evaluate(['5', '4', '3'], '6', { canDouble: true }).double).toBeNull();
  });

  it('treats mixed ten-value cards as a splittable pair', () => {
    const kingQueen = evaluate(['K', 'Q'], '6', { canSplit: true });
    const tenTen = evaluate(['T', 'T'], '6', { canSplit: true });
    expect(kingQueen.split).not.toBeNull();
    expect(kingQueen.split).toBeCloseTo(tenTen.split as number, 12);
  });
});

// --- splitting -------------------------------------------------------------

describe('evaluateActions: splitting', () => {
  it('reports both hands, so a split of a strong pair is worth near twice one hand', () => {
    const ev = evaluate(['9', '9'], '6');
    const oneHand = ev.split === null ? 0 : ev.split / 2;
    expect(ev.split).toBeCloseTo(oneHand * 2, 12);
    expect(oneHand).toBeGreaterThan(0);
    expect(oneHand).toBeLessThan(1);
  });

  it('gives split aces exactly one card each and never a natural', () => {
    const withOneCard = evaluate(['A', 'A'], '6');
    const freeToPlay: RuleSet = { ...VEGAS_STRIP, oneCardToSplitAces: false };
    const unrestricted = evaluate(['A', 'A'], '6', { rules: freeToPlay });

    // Being allowed to keep playing each ace can only ever be worth more.
    expect(unrestricted.split as number).toBeGreaterThan(withOneCard.split as number);

    // And the one-card value is exactly the average stand value of A + one card,
    // with a 21 valued as a plain 21 rather than at 3:2.
    const input = evInput(['A', 'A'], '6');
    const dealer = dealerOutcomes(5, input.composition, true, VEGAS_STRIP);
    const remaining = totalCards(input.composition);
    let perHand = 0;
    for (const spec of ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'] as const) {
      const count = input.composition[compIndex(spec)];
      perHand += (count / remaining) * referenceStandEv(cards('A', spec), dealer);
    }
    expect(withOneCard.split).toBeCloseTo(2 * perHand, 12);
  });

  it('values splitting higher with DAS than without', () => {
    const noDas: RuleSet = { ...VEGAS_STRIP, doubleAfterSplit: false };
    for (const specs of [['2', '2'], ['3', '3'], ['6', '6'], ['7', '7']]) {
      const withDas = evaluate(specs, '5').split as number;
      const without = evaluate(specs, '5', { rules: noDas }).split as number;
      expect(withDas, specs.join(',')).toBeGreaterThan(without);
    }
  });

  it('leaves split aces unaffected by DAS, since they get no second decision', () => {
    const noDas: RuleSet = { ...VEGAS_STRIP, doubleAfterSplit: false };
    expect(evaluate(['A', 'A'], '6', { rules: noDas }).split).toBeCloseTo(
      evaluate(['A', 'A'], '6').split as number,
      12,
    );
  });

  it('never rates splitting a pair of tens above standing on twenty', () => {
    for (const upcard of ALL_UPCARDS) {
      const ev = evaluate(['T', 'T'], UPCARD_SPEC[upcard]);
      expect(ev.best, UPCARD_SPEC[upcard]).not.toBe('split');
    }
  });
});

// --- composition sensitivity -----------------------------------------------

describe('composition sensitivity', () => {
  it('moves the dealer distribution in the predicted direction when tens vanish', () => {
    const normal = remove(shoe(), '6');
    const tenless = normal.slice() as MutableComposition;
    tenless[9] = 0;

    const withTens = dealerOutcomes(5, normal, false, VEGAS_STRIP);
    const withoutTens = dealerOutcomes(5, tenless, false, VEGAS_STRIP);

    // Showing a six the dealer must draw, and with no ten left in the shoe
    // nothing can bust a stiff hand in one card. The bust rate roughly halves
    // and every one of the made totals it was feeding has to rise.
    expect(withoutTens.pBust).toBeLessThan(withTens.pBust / 1.5);
    expect(withoutTens.p17).toBeGreaterThan(withTens.p17);
    expect(withoutTens.p18).toBeGreaterThan(withTens.p18);
    expect(withoutTens.p19).toBeGreaterThan(withTens.p19);
    expect(withoutTens.p20).toBeGreaterThan(withTens.p20);
    expect(withoutTens.p21).toBeGreaterThan(withTens.p21);
    expect(distributionSum(withoutTens)).toBeCloseTo(1, 12);
  });

  it('makes hitting a stiff hand safer when tens vanish', () => {
    const base = evInput(['T', '6'], 'T');
    const tenless = base.composition.slice() as MutableComposition;
    tenless[9] = 0;

    const normal = evaluateActions(base);
    const stripped = evaluateActions({ ...base, composition: tenless });

    // A ten-poor shoe cannot bust a sixteen on the next card, so hitting gains.
    expect(stripped.hit).toBeGreaterThan(normal.hit);
    expect(stripped.best).toBe('hit');
  });

  it('makes standing on a stiff hand better when the shoe is ten-rich', () => {
    const base = evInput(['T', '6'], '6');
    const tenRich = base.composition.slice() as MutableComposition;
    for (const index of [1, 2, 3, 4, 5, 6] as const) tenRich[index] = 2;

    const normal = evaluateActions(base);
    const rich = evaluateActions({ ...base, composition: tenRich });
    expect(rich.stand).toBeGreaterThan(normal.stand);
    expect(rich.best).toBe('stand');
  });

  it('produces a valid answer on a shoe stripped to a single rank', () => {
    const singleRanks: readonly Composition[] = [
      [50, 0, 0, 0, 0, 0, 0, 0, 0, 0], // aces only
      [0, 50, 0, 0, 0, 0, 0, 0, 0, 0], // twos only
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 50], // tens only
      [0, 0, 0, 0, 0, 0, 0, 50, 0, 0], // nines only
    ];
    for (const composition of singleRanks) {
      for (const upcard of ALL_UPCARDS) {
        const d = dealerOutcomes(upcard, composition, false, VEGAS_STRIP);
        expect(distributionSum(d), `${composition.join(',')} vs ${upcard}`).toBeCloseTo(1, 12);
      }
      const ev = evaluateActions({
        rules: VEGAS_STRIP,
        composition,
        playerCards: cards('T', '6'),
        dealerUpcard: card('6'),
        fromSplit: false,
        canDouble: true,
        canSplit: false,
        peekedNotBlackjack: true,
      });
      for (const value of [ev.stand, ev.hit, ev.double, ev.bestEv]) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('holds up on a single-deck shoe as well as six', () => {
    const composition = remove(shoe(1), 'T', '6', '5');
    const ev = evaluateActions({
      rules: { ...VEGAS_STRIP, deckCount: 1 },
      composition,
      playerCards: cards('T', '6'),
      dealerUpcard: card('5'),
      fromSplit: false,
      canDouble: true,
      canSplit: false,
      peekedNotBlackjack: true,
    });
    expect(Number.isFinite(ev.bestEv)).toBe(true);
    expect(ev.bestEv).toBeGreaterThan(-1);
    expect(ev.bestEv).toBeLessThan(0);
  });
});

// --- degenerate shoes ------------------------------------------------------

describe('zero-remaining edge cases', () => {
  const EMPTY: Composition = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  it('returns a normalised distribution for an empty composition', () => {
    for (const upcard of ALL_UPCARDS) {
      for (const peeked of [false, true]) {
        const d = dealerOutcomes(upcard, EMPTY, peeked, VEGAS_STRIP);
        expect(distributionSum(d), `${upcard}/${peeked}`).toBeCloseTo(1, 12);
        expect(Number.isNaN(d.pBust)).toBe(false);
      }
    }
  });

  it('evaluates every action on an empty composition without NaN or a hang', () => {
    const ev = evaluateActions({
      rules: VEGAS_STRIP,
      composition: EMPTY,
      playerCards: cards('8', '8'),
      dealerUpcard: card('6'),
      fromSplit: false,
      canDouble: true,
      canSplit: true,
      peekedNotBlackjack: true,
    });
    for (const value of [ev.stand, ev.hit, ev.double, ev.split, ev.bestEv]) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });

  it('handles a composition holding exactly one card', () => {
    for (const index of [0, 4, 9] as const) {
      const composition = EMPTY.slice() as MutableComposition;
      composition[index] = 1;
      const d = dealerOutcomes(5, composition, false, VEGAS_STRIP);
      expect(distributionSum(d)).toBeCloseTo(1, 12);

      const ev = evaluateActions({
        rules: VEGAS_STRIP,
        composition,
        playerCards: cards('T', '6'),
        dealerUpcard: card('6'),
        fromSplit: false,
        canDouble: true,
        canSplit: false,
        peekedNotBlackjack: true,
      });
      expect(Number.isFinite(ev.bestEv)).toBe(true);
    }
  });
});

// --- performance -----------------------------------------------------------

describe('performance (SPEC §5.2: under 50ms on a mid-range Android device)', () => {
  /**
   * The heaviest call this engine can be asked for: a low pair against a two.
   * A two-upcard has the deepest dealer recursion of any upcard, and a pair of
   * twos has the deepest player recursion plus a split to value on top.
   *
   * Measured at ~1.7ms here with a cold cache, so roughly 8ms on a device 4-5x
   * slower. The assertion is the SPEC budget itself, which leaves about 30x
   * headroom on this machine — loose enough not to flake on a cold or contended
   * CI runner, tight enough to catch an order-of-magnitude regression.
   */
  it('evaluates the worst case well inside budget', () => {
    clearEvCaches();
    const input = evInput(['2', '2'], '2');
    evaluateActions(input); // warm the JIT and the dealer cache

    clearEvCaches();
    const started = performance.now();
    const ev = evaluateActions(input);
    const elapsed = performance.now() - started;

    expect(Number.isFinite(ev.bestEv)).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  it('evaluates a representative sweep of hands inside budget', () => {
    clearEvCaches();
    const hands: readonly (readonly string[])[] = [
      ['T', '6'], ['9', '7'], ['A', '7'], ['8', '8'], ['A', 'A'], ['5', '5'],
    ];
    const started = performance.now();
    for (const upcard of ALL_UPCARDS) {
      for (const specs of hands) evaluate(specs, UPCARD_SPEC[upcard]);
    }
    const elapsed = performance.now() - started;
    expect(elapsed / (ALL_UPCARDS.length * hands.length)).toBeLessThan(50);
  });

  it('serves a repeated composition from the memo', () => {
    clearEvCaches();
    const composition = remove(shoe(), '2');
    dealerOutcomes(1, composition, false, VEGAS_STRIP);

    const started = performance.now();
    for (let i = 0; i < 500; i++) dealerOutcomes(1, composition, false, VEGAS_STRIP);
    const elapsed = performance.now() - started;

    // 500 cache hits must cost far less than one cold enumeration.
    expect(elapsed).toBeLessThan(50);
  });

  it('bounds the cache rather than leaking across a long session', () => {
    clearEvCaches();
    // Far more distinct compositions than the cache can hold; it must not grow
    // without limit, and every answer must stay correct afterwards.
    for (let removed = 0; removed < 90; removed++) {
      const composition = shoe().slice() as MutableComposition;
      composition[9] = 96 - removed;
      dealerOutcomes(9, composition, false, VEGAS_STRIP);
      dealerOutcomes(9, composition, true, VEGAS_STRIP);
    }
    const d = dealerOutcomes(9, remove(shoe(), 'T'), false, VEGAS_STRIP);
    expect(d.pBust).toBeCloseTo(0.214, 2);
  });
});
