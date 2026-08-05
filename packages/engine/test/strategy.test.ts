import { describe, it, expect } from 'vitest';

import { RANKS, SUITS, type Card, type Rank, type Suit } from '../src/cards.js';
import {
  createHand,
  handTotal,
  isPair,
  legalActions,
  type Action,
  type Hand,
  type LegalActionContext,
} from '../src/hand.js';
import { VEGAS_STRIP, type RuleSet } from '../src/rules.js';
import {
  chartLookup,
  recommend,
  recommendInsurance,
  type ChartAction,
  type ReasonCode,
} from '../src/strategy.js';

// --- helpers ---------------------------------------------------------------

/** Same compact card builder as hand.test.ts: `cards('AS', 'TD')` or `cards('A', '7')`. */
function cards(...specs: readonly string[]): Card[] {
  return specs.map((spec, i) => {
    const rank = spec.slice(0, 1) as Rank;
    const suit = (spec.length > 1 ? spec.slice(1, 2) : SUITS[i % SUITS.length]) as Suit;
    return { rank, suit, id: `${rank}${suit}#${i}` };
  });
}

function upcard(rank: Rank): Card {
  return { rank, suit: 'S', id: `${rank}S#up` };
}

const DEFAULT_BET = 10;

function makeHand(specs: readonly string[], overrides: Partial<Hand> = {}): Hand {
  return { ...createHand(cards(...specs), DEFAULT_BET), ...overrides };
}

function ctx(overrides: Partial<LegalActionContext> = {}): LegalActionContext {
  return { rules: VEGAS_STRIP, handCount: 1, availableFunds: 1000, ...overrides };
}

const NO_DAS: RuleSet = { ...VEGAS_STRIP, doubleAfterSplit: false };

/** The ten chart columns, in printed-chart order. */
const UPCARDS: readonly Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'A'];

const ALL_CHART_ACTIONS: readonly ChartAction[] = ['H', 'S', 'D', 'Ds', 'P', 'Ph'];

const ALL_REASON_CODES: readonly ReasonCode[] = [
  'CANT_BUST_ALWAYS_HIT',
  'DEALER_WEAK_LET_THEM_BUST',
  'DEALER_STRONG_MUST_IMPROVE',
  'SOFT_HAND_CANT_BUST',
  'DOUBLE_WHEN_DEALER_LIKELY_BUSTS',
  'DOUBLE_STRONG_TOTAL',
  'STAND_ON_A_MADE_HAND',
  'SPLIT_TWO_HANDS_BEAT_ONE',
  'ALWAYS_SPLIT_ACES',
  'ALWAYS_SPLIT_EIGHTS',
  'NEVER_SPLIT_TENS',
  'NEVER_SPLIT_FIVES',
  'INSURANCE_IS_A_SUCKER_BET',
  'CLOSEST_CALL',
  'DAMAGE_CONTROL',
];

/** The action a chart cell names, when nothing stands in its way. */
const NATURAL_ACTION: Readonly<Record<ChartAction, Action>> = {
  H: 'hit',
  S: 'stand',
  D: 'double',
  Ds: 'double',
  P: 'split',
  Ph: 'split',
};

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

/**
 * Read one whole chart row back out through the public API, as a string in the
 * same shape the tables are written in. Comparing rows rather than cells means
 * a test failure names the row and shows the whole line, which is how anyone
 * would actually check it against a printed chart.
 */
function chartRow(specs: readonly string[]): string {
  return UPCARDS.map((rank) => chartLookup(cards(...specs), upcard(rank), VEGAS_STRIP).action).join(
    ' ',
  );
}

const ALL_STAND = 'S S S S S S S S S S';

// --- completeness ----------------------------------------------------------

describe('chartLookup completeness (SPEC §8: no gaps)', () => {
  const sampleSizes = [2, 3, 4];

  it('returns a well-formed cell for every reachable hand against every upcard', () => {
    for (const size of sampleSizes) {
      for (const ranks of rankCombinations(size)) {
        for (const rank of UPCARDS) {
          const label = `${ranks.join(',')} vs ${rank}`;
          const cell = chartLookup(cards(...ranks), upcard(rank), VEGAS_STRIP);
          expect(cell, label).toBeDefined();
          expect(ALL_CHART_ACTIONS, label).toContain(cell.action);
          expect(ALL_REASON_CODES, label).toContain(cell.reasonCode);
        }
      }
    }
  });

  it('covers every hard 5-21, soft 13-21 and pair row with no missing cell', () => {
    // Which table row a hand lands on, mirroring the lookup's own branching.
    const rowKey = (hand: readonly Card[]): string | null => {
      if (isPair(hand)) {
        const rank = hand[0]?.rank;
        return rank === undefined ? null : `pair-${rank === 'A' ? 'A' : rank}`;
      }
      const { total, soft } = handTotal(hand);
      if (total > 21) return null; // busted: not a decision point
      return `${soft ? 'soft' : 'hard'}-${total}`;
    };

    const seen = new Map<string, number>();
    for (const size of sampleSizes) {
      for (const ranks of rankCombinations(size)) {
        const hand = cards(...ranks);
        const key = rowKey(hand);
        if (key === null) continue;
        for (const rank of UPCARDS) {
          const cell = chartLookup(hand, upcard(rank), VEGAS_STRIP);
          expect(cell.action, `${key} vs ${rank}`).toBeDefined();
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
    }

    const expected: string[] = [];
    for (let total = 5; total <= 21; total++) expected.push(`hard-${total}`);
    for (let total = 13; total <= 21; total++) expected.push(`soft-${total}`);
    for (const rank of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'A']) {
      expected.push(`pair-${rank}`);
    }

    for (const key of expected) {
      expect(seen.get(key) ?? 0, `no cells found for ${key}`).toBeGreaterThanOrEqual(
        UPCARDS.length,
      );
    }
  });

  it('answers for a busted hand rather than throwing', () => {
    // Not a decision point, but the coaching layer must never explode on one.
    expect(chartLookup(cards('T', '9', '5'), upcard('T'), VEGAS_STRIP).action).toBe('S');
  });
});

// --- the chart itself ------------------------------------------------------

describe('hard totals (6 deck, S17, DAS, no surrender)', () => {
  it.each([
    { total: 5, specs: ['2', '3'], row: 'H H H H H H H H H H' },
    { total: 6, specs: ['2', '4'], row: 'H H H H H H H H H H' },
    { total: 7, specs: ['2', '5'], row: 'H H H H H H H H H H' },
    { total: 8, specs: ['2', '6'], row: 'H H H H H H H H H H' },
    { total: 9, specs: ['2', '7'], row: 'H D D D D H H H H H' },
    { total: 10, specs: ['2', '8'], row: 'D D D D D D D D H H' },
    { total: 11, specs: ['2', '9'], row: 'D D D D D D D D D H' },
    { total: 12, specs: ['2', 'T'], row: 'H H S S S H H H H H' },
    { total: 13, specs: ['3', 'T'], row: 'S S S S S H H H H H' },
    { total: 14, specs: ['4', 'T'], row: 'S S S S S H H H H H' },
    { total: 15, specs: ['5', 'T'], row: 'S S S S S H H H H H' },
    { total: 16, specs: ['6', 'T'], row: 'S S S S S H H H H H' },
    { total: 17, specs: ['7', 'T'], row: ALL_STAND },
    { total: 18, specs: ['8', 'T'], row: ALL_STAND },
    { total: 19, specs: ['9', 'T'], row: ALL_STAND },
    { total: 20, specs: ['T', '7', '3'], row: ALL_STAND },
    { total: 21, specs: ['T', '8', '3'], row: ALL_STAND },
  ])('hard $total reads $row', ({ specs, row }) => {
    expect(chartRow(specs)).toBe(row);
  });

  it('stands a 12 only against 4, 5 and 6', () => {
    expect(chartRow(['2', 'T'])).toBe('H H S S S H H H H H');
  });

  it('hits a 16 against 7 through ace — there is no surrender in this rule set', () => {
    expect(VEGAS_STRIP.surrender).toBe(false);
    expect(chartRow(['6', 'T'])).toBe('S S S S S H H H H H');
  });

  it('doubles 11 against 2 through 10 but hits it against an ace, which is S17-specific', () => {
    // At an H17 table this cell doubles. VEGAS_STRIP stands the dealer on soft
    // 17, which takes away a round of dealer bust equity and the extra bet with it.
    expect(VEGAS_STRIP.dealerHitsSoft17).toBe(false);
    expect(chartRow(['2', '9'])).toBe('D D D D D D D D D H');
  });

  it('doubles 9 against 3 through 6 only', () => {
    expect(chartRow(['4', '5'])).toBe('H D D D D H H H H H');
  });

  it('reads the same for every set of cards making the same hard total', () => {
    for (const specs of [['5', '6'], ['4', '7'], ['2', '3', '6'], ['2', '2', '3', '4']]) {
      expect(handTotal(cards(...specs)).total, specs.join(',')).toBe(11);
      expect(chartRow(specs), specs.join(',')).toBe('D D D D D D D D D H');
    }
  });
});

describe('soft totals', () => {
  it.each([
    { hand: 'A,2', specs: ['A', '2'], row: 'H H H D D H H H H H' },
    { hand: 'A,3', specs: ['A', '3'], row: 'H H H D D H H H H H' },
    { hand: 'A,4', specs: ['A', '4'], row: 'H H D D D H H H H H' },
    { hand: 'A,5', specs: ['A', '5'], row: 'H H D D D H H H H H' },
    { hand: 'A,6', specs: ['A', '6'], row: 'H D D D D H H H H H' },
    { hand: 'A,7', specs: ['A', '7'], row: 'S Ds Ds Ds Ds S S H H H' },
    { hand: 'A,8', specs: ['A', '8'], row: ALL_STAND },
    { hand: 'A,9', specs: ['A', '9'], row: ALL_STAND },
    { hand: 'A,T', specs: ['A', 'T'], row: ALL_STAND },
  ])('soft $hand reads $row', ({ specs, row }) => {
    expect(chartRow(specs)).toBe(row);
  });

  it('plays soft 18 the S17 way: stand vs 2, Ds vs 3-6, stand vs 7 and 8, hit vs 9, T and A', () => {
    // A,7 vs 2 is the other cell an H17 chart gets differently — it doubles there.
    expect(VEGAS_STRIP.dealerHitsSoft17).toBe(false);
    expect(chartRow(['A', '7'])).toBe('S Ds Ds Ds Ds S S H H H');
  });

  it('doubles soft 13 and 14 against 5-6, and soft 15 and 16 against 4-6', () => {
    expect(chartRow(['A', '2'])).toBe('H H H D D H H H H H');
    expect(chartRow(['A', '3'])).toBe('H H H D D H H H H H');
    expect(chartRow(['A', '4'])).toBe('H H D D D H H H H H');
    expect(chartRow(['A', '5'])).toBe('H H D D D H H H H H');
  });

  it('treats a three-card soft hand as its soft total', () => {
    // A,2,4 is a soft 17 and reads as the A,6 row.
    expect(chartRow(['A', '2', '4'])).toBe('H D D D D H H H H H');
  });

  it('reads a demoted ace off the hard chart', () => {
    // A,6,T is a hard 17, not a soft anything.
    expect(chartRow(['A', '6', 'T'])).toBe(ALL_STAND);
  });
});

describe('the two cells an H17 chart gets differently', () => {
  // VEGAS_STRIP stands the dealer on soft 17 (SPEC §2), and these are the two
  // cells where that changes the answer. Both are commonly mis-transcribed from
  // an H17 chart, and both are checked here by name so the next person to
  // "correct" them has to read this first.
  it('hits hard 11 against an ace, and doubles it against everything else', () => {
    expect(VEGAS_STRIP.dealerHitsSoft17).toBe(false);
    expect(chartLookup(cards('7', '4'), upcard('A'), VEGAS_STRIP).action).toBe('H');
    expect(chartLookup(cards('7', '4'), upcard('T'), VEGAS_STRIP).action).toBe('D');
  });

  it('stands soft 18 against a 2, and doubles it against a 3', () => {
    expect(chartLookup(cards('A', '7'), upcard('2'), VEGAS_STRIP).action).toBe('S');
    expect(chartLookup(cards('A', '7'), upcard('3'), VEGAS_STRIP).action).toBe('Ds');
  });

  it('calls both of them what they are: close', () => {
    expect(chartLookup(cards('7', '4'), upcard('A'), VEGAS_STRIP).reasonCode).toBe('CLOSEST_CALL');
    expect(chartLookup(cards('A', '7'), upcard('2'), VEGAS_STRIP).reasonCode).toBe('CLOSEST_CALL');
  });
});

describe('pairs', () => {
  it.each([
    { pair: 'A,A', specs: ['A', 'A'], row: 'P P P P P P P P P P' },
    { pair: '2,2', specs: ['2', '2'], row: 'Ph Ph P P P P H H H H' },
    { pair: '3,3', specs: ['3', '3'], row: 'Ph Ph P P P P H H H H' },
    { pair: '4,4', specs: ['4', '4'], row: 'H H H Ph Ph H H H H H' },
    { pair: '5,5', specs: ['5', '5'], row: 'D D D D D D D D H H' },
    { pair: '6,6', specs: ['6', '6'], row: 'Ph P P P P H H H H H' },
    { pair: '7,7', specs: ['7', '7'], row: 'P P P P P P H H H H' },
    { pair: '8,8', specs: ['8', '8'], row: 'P P P P P P P P P P' },
    { pair: '9,9', specs: ['9', '9'], row: 'P P P P P S P P S S' },
    { pair: 'T,T', specs: ['T', 'T'], row: ALL_STAND },
  ])('$pair reads $row', ({ specs, row }) => {
    expect(chartRow(specs)).toBe(row);
  });

  it('always splits aces and eights', () => {
    expect(chartRow(['A', 'A'])).toBe('P P P P P P P P P P');
    expect(chartRow(['8', '8'])).toBe('P P P P P P P P P P');
  });

  it('never splits tens or fives: 5,5 is a hard 10 and T,T is a made 20', () => {
    expect(chartRow(['5', '5'])).toBe(chartRow(['2', '8']));
    expect(chartRow(['T', 'T'])).toBe(ALL_STAND);
  });

  it('splits 4,4 only against 5 and 6, and only with DAS', () => {
    expect(chartRow(['4', '4'])).toBe('H H H Ph Ph H H H H H');
  });

  it('splits 6,6 against 3-6, and against 2 only with DAS', () => {
    expect(chartRow(['6', '6'])).toBe('Ph P P P P H H H H H');
  });

  it('splits 2,2 and 3,3 against 4-7, and against 2 and 3 only with DAS', () => {
    expect(chartRow(['2', '2'])).toBe('Ph Ph P P P P H H H H');
    expect(chartRow(['3', '3'])).toBe('Ph Ph P P P P H H H H');
  });

  it('splits 7,7 against 2-7 and hits it thereafter', () => {
    expect(chartRow(['7', '7'])).toBe('P P P P P P H H H H');
  });

  it('splits 9,9 against 2-6 and 8-9, but stands against 7, T and A', () => {
    expect(chartRow(['9', '9'])).toBe('P P P P P S P P S S');
  });

  it('treats mixed ten-value cards as a pair of tens', () => {
    expect(chartRow(['K', 'Q'])).toBe(ALL_STAND);
    expect(chartRow(['J', 'T'])).toBe(ALL_STAND);
  });

  it('stops treating a pair as a pair once a third card lands', () => {
    // 8,8,5 is a hard 21, not a split.
    expect(chartRow(['8', '8', '5'])).toBe(ALL_STAND);
  });
});

// --- reason codes ----------------------------------------------------------

describe('reason codes', () => {
  const reasonFor = (specs: readonly string[], up: Rank): ReasonCode =>
    chartLookup(cards(...specs), upcard(up), VEGAS_STRIP).reasonCode;

  it.each([
    { specs: ['2', '3'], up: 'T' as Rank, code: 'CANT_BUST_ALWAYS_HIT' },
    { specs: ['2', '9'], up: '6' as Rank, code: 'DOUBLE_WHEN_DEALER_LIKELY_BUSTS' },
    { specs: ['2', '9'], up: '9' as Rank, code: 'DOUBLE_STRONG_TOTAL' },
    { specs: ['2', '8'], up: '8' as Rank, code: 'DOUBLE_STRONG_TOTAL' },
    { specs: ['2', '9'], up: 'A' as Rank, code: 'CLOSEST_CALL' },
    { specs: ['6', 'T'], up: '5' as Rank, code: 'DEALER_WEAK_LET_THEM_BUST' },
    { specs: ['6', 'T'], up: '7' as Rank, code: 'DEALER_STRONG_MUST_IMPROVE' },
    { specs: ['6', 'T'], up: 'T' as Rank, code: 'DAMAGE_CONTROL' },
    { specs: ['2', 'T'], up: '2' as Rank, code: 'DAMAGE_CONTROL' },
    { specs: ['2', 'T'], up: '3' as Rank, code: 'DAMAGE_CONTROL' },
    { specs: ['2', 'T'], up: '4' as Rank, code: 'CLOSEST_CALL' },
    { specs: ['A', '7'], up: '2' as Rank, code: 'CLOSEST_CALL' },
    { specs: ['A', '3'], up: 'T' as Rank, code: 'SOFT_HAND_CANT_BUST' },
    { specs: ['A', '9'], up: 'T' as Rank, code: 'STAND_ON_A_MADE_HAND' },
    { specs: ['A', 'A'], up: '5' as Rank, code: 'ALWAYS_SPLIT_ACES' },
    { specs: ['8', '8'], up: 'A' as Rank, code: 'ALWAYS_SPLIT_EIGHTS' },
    { specs: ['T', 'T'], up: '6' as Rank, code: 'NEVER_SPLIT_TENS' },
    { specs: ['5', '5'], up: '6' as Rank, code: 'NEVER_SPLIT_FIVES' },
    { specs: ['5', '5'], up: 'A' as Rank, code: 'NEVER_SPLIT_FIVES' },
    { specs: ['7', '7'], up: '4' as Rank, code: 'SPLIT_TWO_HANDS_BEAT_ONE' },
    { specs: ['2', '2'], up: '2' as Rank, code: 'SPLIT_TWO_HANDS_BEAT_ONE' },
  ])('$specs vs $up is explained by $code', ({ specs, up, code }) => {
    expect(reasonFor(specs, up)).toBe(code);
  });

  it('explains a pair it declines to split by that hand’s total, not by the pair', () => {
    // 7,7 vs T is a hard 14 against a ten: a loser either way.
    expect(reasonFor(['7', '7'], 'T')).toBe(reasonFor(['4', 'T'], 'T'));
    expect(reasonFor(['7', '7'], 'T')).toBe('DAMAGE_CONTROL');
    // 9,9 vs 7 keeps its 18.
    expect(reasonFor(['9', '9'], '7')).toBe('STAND_ON_A_MADE_HAND');
  });

  it('never returns INSURANCE_IS_A_SUCKER_BET from a playing decision', () => {
    for (const ranks of rankCombinations(2)) {
      for (const up of UPCARDS) {
        expect(chartLookup(cards(...ranks), upcard(up), VEGAS_STRIP).reasonCode).not.toBe(
          'INSURANCE_IS_A_SUCKER_BET',
        );
      }
    }
  });
});

// --- the invariant that matters most ---------------------------------------

describe('recommend never suggests an illegal action', () => {
  const contexts: readonly LegalActionContext[] = [
    ctx(),
    ctx({ handCount: 4 }),
    ctx({ availableFunds: 0 }),
    ctx({ availableFunds: DEFAULT_BET - 1 }),
    ctx({ availableFunds: DEFAULT_BET }),
    ctx({ rules: NO_DAS }),
    ctx({ rules: NO_DAS, availableFunds: 0 }),
  ];

  const variants: readonly Partial<Hand>[] = [
    {},
    { fromSplit: true },
    { fromSplit: true, fromSplitAces: true },
    { stood: true },
  ];

  it('returns an action from legalActions for every hand, context and upcard', () => {
    for (const size of [2, 3]) {
      for (const ranks of rankCombinations(size)) {
        for (const variant of variants) {
          const hand = makeHand(ranks, variant);
          for (const context of contexts) {
            const legal = legalActions(hand, context);
            for (const up of UPCARDS) {
              const label = `${ranks.join(',')} vs ${up}`;
              if (legal.length === 0) {
                expect(() => recommend(hand, upcard(up), context), label).toThrow();
                continue;
              }
              const rec = recommend(hand, upcard(up), context);
              expect(legal, label).toContain(rec.action);
            }
          }
        }
      }
    }
  });

  it('reports the chart action unchanged, and flags a fallback whenever it collapsed', () => {
    for (const ranks of rankCombinations(2)) {
      for (const variant of variants) {
        const hand = makeHand(ranks, variant);
        for (const context of contexts) {
          if (legalActions(hand, context).length === 0) continue;
          for (const up of UPCARDS) {
            const label = `${ranks.join(',')} vs ${up}`;
            const rec = recommend(hand, upcard(up), context);
            const cell = chartLookup(hand.cards, upcard(up), context.rules);
            expect(rec.chartAction, label).toBe(cell.action);
            expect(ALL_REASON_CODES, label).toContain(rec.reasonCode);
            // A `Ph` cell at a table without DAS is the chart branching to the
            // non-pair answer by its own definition, not a denied first choice.
            const chartDeclinedTheSplit =
              rec.chartAction === 'Ph' && !context.rules.doubleAfterSplit;
            if (!rec.fallback && !chartDeclinedTheSplit) {
              // Nothing was denied, so the action is the chart's own first choice.
              expect(rec.action, label).toBe(NATURAL_ACTION[rec.chartAction]);
            }
          }
        }
      }
    }
  });

  it('takes the chart action outright whenever it is legal', () => {
    for (const ranks of rankCombinations(2)) {
      const hand = makeHand(ranks);
      const context = ctx();
      for (const up of UPCARDS) {
        const legal = legalActions(hand, context);
        if (legal.length === 0) continue;
        const cell = chartLookup(hand.cards, upcard(up), VEGAS_STRIP);
        const natural = NATURAL_ACTION[cell.action];
        if (!legal.includes(natural)) continue;
        const rec = recommend(hand, upcard(up), context);
        expect(rec.action, `${ranks.join(',')} vs ${up}`).toBe(natural);
        expect(rec.fallback, `${ranks.join(',')} vs ${up}`).toBe(false);
      }
    }
  });

  describe('throws rather than inventing advice', () => {
    it.each([
      { name: 'a resolved hand (two-card natural)', hand: makeHand(['A', 'T']) },
      { name: 'a busted hand', hand: makeHand(['T', '9', '5']) },
      { name: 'a stood hand', hand: makeHand(['T', '6'], { stood: true }) },
      {
        name: 'a split hand still holding one card',
        hand: makeHand(['8'], { fromSplit: true }),
      },
      {
        name: 'a split ace that has taken its one card',
        hand: makeHand(['A', '7'], { fromSplit: true, fromSplitAces: true }),
      },
    ])('$name', ({ hand }) => {
      expect(legalActions(hand, ctx())).toEqual([]);
      expect(() => recommend(hand, upcard('6'), ctx())).toThrow(/no legal actions/);
    });
  });
});

// --- fallback behaviour ----------------------------------------------------

describe('fallback when the chart’s first choice is unavailable', () => {
  describe('a split it cannot make falls through to the non-pair answer', () => {
    it.each([
      {
        name: '8,8 vs T at the four-hand limit is a hard 16: hit',
        specs: ['8', '8'],
        up: 'T' as Rank,
        context: ctx({ handCount: 4 }),
        action: 'hit' as Action,
        chartAction: 'P' as ChartAction,
        reasonCode: 'DAMAGE_CONTROL' as ReasonCode,
      },
      {
        name: '8,8 vs 6 with no funds is a hard 16: stand',
        specs: ['8', '8'],
        up: '6' as Rank,
        context: ctx({ availableFunds: 0 }),
        action: 'stand' as Action,
        chartAction: 'P' as ChartAction,
        reasonCode: 'DEALER_WEAK_LET_THEM_BUST' as ReasonCode,
      },
      {
        name: '4,4 vs 6 at the limit is a hard 8: hit',
        specs: ['4', '4'],
        up: '6' as Rank,
        context: ctx({ handCount: 4 }),
        action: 'hit' as Action,
        chartAction: 'Ph' as ChartAction,
        reasonCode: 'CANT_BUST_ALWAYS_HIT' as ReasonCode,
      },
      {
        name: '2,2 vs 5 at the limit is a hard 4: hit',
        specs: ['2', '2'],
        up: '5' as Rank,
        context: ctx({ handCount: 4 }),
        action: 'hit' as Action,
        chartAction: 'P' as ChartAction,
        reasonCode: 'CANT_BUST_ALWAYS_HIT' as ReasonCode,
      },
      {
        name: '9,9 vs 6 at the limit is a hard 18: stand',
        specs: ['9', '9'],
        up: '6' as Rank,
        context: ctx({ handCount: 4 }),
        action: 'stand' as Action,
        chartAction: 'P' as ChartAction,
        reasonCode: 'STAND_ON_A_MADE_HAND' as ReasonCode,
      },
      {
        name: 'A,A vs 6 at the limit is a soft 12: hit',
        specs: ['A', 'A'],
        up: '6' as Rank,
        context: ctx({ handCount: 4 }),
        action: 'hit' as Action,
        chartAction: 'P' as ChartAction,
        reasonCode: 'SOFT_HAND_CANT_BUST' as ReasonCode,
      },
      {
        name: 'A,A vs T with no funds is a soft 12: hit',
        specs: ['A', 'A'],
        up: 'T' as Rank,
        context: ctx({ availableFunds: 0 }),
        action: 'hit' as Action,
        chartAction: 'P' as ChartAction,
        reasonCode: 'SOFT_HAND_CANT_BUST' as ReasonCode,
      },
      {
        name: '6,6 vs 4 at the limit is a hard 12: stand',
        specs: ['6', '6'],
        up: '4' as Rank,
        context: ctx({ handCount: 4 }),
        action: 'stand' as Action,
        chartAction: 'P' as ChartAction,
        reasonCode: 'CLOSEST_CALL' as ReasonCode,
      },
    ])('$name', ({ specs, up, context, action, chartAction, reasonCode }) => {
      const hand = makeHand(specs);
      expect(legalActions(hand, context)).not.toContain('split');
      const rec = recommend(hand, upcard(up), context);
      expect(rec).toEqual({ action, chartAction, reasonCode, fallback: true });
    });

    it('falls through for a pair of aces that may not be resplit', () => {
      const hand = makeHand(['A', 'A'], { fromSplit: true });
      expect(VEGAS_STRIP.resplitAces).toBe(false);
      expect(legalActions(hand, ctx())).not.toContain('split');
      const rec = recommend(hand, upcard('6'), ctx());
      expect(rec.chartAction).toBe('P');
      expect(rec.action).toBe('hit');
      expect(rec.fallback).toBe(true);
    });

    it('still splits when the seat has room and the money', () => {
      for (const handCount of [1, 2, 3]) {
        const rec = recommend(makeHand(['8', '8']), upcard('T'), ctx({ handCount }));
        expect(rec).toEqual({
          action: 'split',
          chartAction: 'P',
          reasonCode: 'ALWAYS_SPLIT_EIGHTS',
          fallback: false,
        });
      }
    });
  });

  describe('a double it cannot make', () => {
    it('collapses D to hit', () => {
      const rec = recommend(makeHand(['2', '9']), upcard('6'), ctx({ availableFunds: 0 }));
      expect(rec.chartAction).toBe('D');
      expect(rec.action).toBe('hit');
      expect(rec.fallback).toBe(true);
      // The reason still explains the double the seat cannot afford; the
      // fallback flag is what tells the UI to say so.
      expect(rec.reasonCode).toBe('DOUBLE_WHEN_DEALER_LIKELY_BUSTS');
    });

    it('collapses Ds to stand', () => {
      const rec = recommend(makeHand(['A', '7']), upcard('3'), ctx({ availableFunds: 0 }));
      expect(rec.chartAction).toBe('Ds');
      expect(rec.action).toBe('stand');
      expect(rec.fallback).toBe(true);
    });

    it('collapses D to hit once a third card has landed', () => {
      const rec = recommend(makeHand(['2', '4', '5']), upcard('6'), ctx());
      expect(rec.chartAction).toBe('D');
      expect(rec.action).toBe('hit');
      expect(rec.fallback).toBe(true);
    });

    it('collapses Ds to stand once a third card has landed', () => {
      const rec = recommend(makeHand(['A', '3', '4']), upcard('4'), ctx());
      expect(rec.chartAction).toBe('Ds');
      expect(rec.action).toBe('stand');
      expect(rec.fallback).toBe(true);
    });

    it('collapses D to hit on a split hand when the house forbids DAS', () => {
      const hand = makeHand(['5', '6'], { fromSplit: true });
      const context = ctx({ rules: NO_DAS });
      expect(legalActions(hand, context)).not.toContain('double');
      const rec = recommend(hand, upcard('6'), context);
      expect(rec.chartAction).toBe('D');
      expect(rec.action).toBe('hit');
      expect(rec.fallback).toBe(true);
    });

    it('collapses Ds to stand on a split hand when the house forbids DAS', () => {
      const hand = makeHand(['A', '7'], { fromSplit: true });
      const rec = recommend(hand, upcard('4'), ctx({ rules: NO_DAS }));
      expect(rec.chartAction).toBe('Ds');
      expect(rec.action).toBe('stand');
      expect(rec.fallback).toBe(true);
    });

    it('doubles a split hand normally under VEGAS_STRIP, which allows DAS', () => {
      expect(VEGAS_STRIP.doubleAfterSplit).toBe(true);
      const rec = recommend(makeHand(['5', '6'], { fromSplit: true }), upcard('6'), ctx());
      expect(rec.action).toBe('double');
      expect(rec.fallback).toBe(false);
    });
  });

  describe('Ph without DAS is the chart branching, not a collapse', () => {
    it.each([
      { specs: ['4', '4'], up: '6' as Rank, action: 'hit' as Action },
      { specs: ['2', '2'], up: '3' as Rank, action: 'hit' as Action },
      { specs: ['3', '3'], up: '2' as Rank, action: 'hit' as Action },
      { specs: ['6', '6'], up: '2' as Rank, action: 'hit' as Action },
    ])('$specs vs $up hits instead of splitting', ({ specs, up, action }) => {
      const rec = recommend(makeHand(specs), upcard(up), ctx({ rules: NO_DAS }));
      expect(rec.chartAction).toBe('Ph');
      expect(rec.action).toBe(action);
      // The cell reads "split if DAS else hit": with DAS off, hitting *is* the
      // book answer, so nothing was denied and nothing is flagged.
      expect(rec.fallback).toBe(false);
    });

    it('splits the same cells under VEGAS_STRIP, which allows DAS', () => {
      for (const [specs, up] of [
        [['4', '4'], '6'],
        [['2', '2'], '3'],
        [['6', '6'], '2'],
      ] as const) {
        const rec = recommend(makeHand([...specs]), upcard(up), ctx());
        expect(rec.chartAction, specs.join(',')).toBe('Ph');
        expect(rec.action, specs.join(',')).toBe('split');
        expect(rec.fallback, specs.join(',')).toBe(false);
      }
    });

    it.each([
      { name: '6,6 vs 2 becomes a hard 12', specs: ['6', '6'], up: '2' as Rank, code: 'DAMAGE_CONTROL' },
      { name: '4,4 vs 6 becomes a hard 8', specs: ['4', '4'], up: '6' as Rank, code: 'CANT_BUST_ALWAYS_HIT' },
      { name: '2,2 vs 3 becomes a hard 4', specs: ['2', '2'], up: '3' as Rank, code: 'CANT_BUST_ALWAYS_HIT' },
    ])('explains it as the total it becomes — $name', ({ specs, up, code }) => {
      // The advice is about the total now, so the explanation must be too.
      const rec = recommend(makeHand(specs), upcard(up), ctx({ rules: NO_DAS }));
      expect(rec.reasonCode).toBe(code);
    });
  });
});

// --- insurance -------------------------------------------------------------

describe('recommendInsurance', () => {
  it('never takes insurance (SPEC §2, §5.4)', () => {
    expect(recommendInsurance()).toEqual({
      take: false,
      reasonCode: 'INSURANCE_IS_A_SUCKER_BET',
    });
  });

  it('is a constant: it does not depend on the hand, and it is offered at all', () => {
    expect(VEGAS_STRIP.insuranceOffered).toBe(true);
    expect(recommendInsurance()).toEqual(recommendInsurance());
  });
});
