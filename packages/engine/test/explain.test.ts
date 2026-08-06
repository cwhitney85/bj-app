import { describe, expect, it } from 'vitest';

import { compIndex, type Card, type Composition, type MutableComposition, type Rank, type Suit } from '../src/cards.js';
import { evaluateActions, type ActionEv, type EvInput } from '../src/ev.js';
import { createHand, legalActions, type Action, type Hand, type LegalActionContext } from '../src/hand.js';
import { freshShoeComposition } from '../src/knowledge.js';
import { VEGAS_STRIP, type RuleSet } from '../src/rules.js';
import { recommend, REASON_CODES, type ReasonCode, type Recommendation } from '../src/strategy.js';
import { explain, explainInsurance, type Explanation } from '../src/explain.js';

// --- Helpers ---------------------------------------------------------------

function card(rank: Rank, suit: Suit = 'S'): Card {
  return { rank, suit, id: `${rank}${suit}` };
}

function cards(...ranks: readonly Rank[]): readonly Card[] {
  const suits: readonly Suit[] = ['S', 'H', 'D', 'C'];
  return ranks.map((rank, i) => ({ rank, suit: suits[i % 4] as Suit, id: `${rank}-${i}` }));
}

/** A fresh shoe with the player's cards and the dealer upcard removed — the
 *  precondition `evaluateActions` documents for its composition input. */
function compositionAfter(dealt: readonly Card[], rules: RuleSet = VEGAS_STRIP): Composition {
  const comp = freshShoeComposition(rules.deckCount).slice() as MutableComposition;
  for (const c of dealt) comp[compIndex(c.rank)]--;
  return comp;
}

type Situation = {
  readonly input: EvInput;
  readonly ev: ActionEv;
  readonly recommendation: Recommendation;
  readonly explanation: Explanation;
};

/**
 * Drive the whole coaching path for one hand: chart → EV → prose. Going through
 * `recommend` and `evaluateActions` rather than hand-building their outputs is
 * the point — it is the only way the test can catch prose that quotes numbers
 * the player is not being shown.
 */
function situation(
  playerRanks: readonly Rank[],
  upcardRank: Rank,
  options: {
    readonly rules?: RuleSet;
    readonly handCount?: number;
    readonly availableFunds?: number;
    readonly fromSplit?: boolean;
    readonly composition?: Composition;
  } = {},
): Situation {
  const rules = options.rules ?? VEGAS_STRIP;
  const playerCards = cards(...playerRanks);
  const dealerUpcard = card(upcardRank, 'H');
  const composition = options.composition ?? compositionAfter([...playerCards, dealerUpcard], rules);

  const hand: Hand = {
    ...createHand(playerCards, 10),
    fromSplit: options.fromSplit ?? false,
  };
  const context: LegalActionContext = {
    rules,
    handCount: options.handCount ?? 1,
    availableFunds: options.availableFunds ?? 1000,
  };
  const recommendation = recommend(hand, dealerUpcard, context);
  // The availability flags must agree with what the seat may actually do, or
  // the prose would compare against an action the buttons do not offer.
  const legal = new Set<Action>(legalActions(hand, context));

  const input: EvInput = {
    rules,
    composition,
    playerCards,
    dealerUpcard,
    fromSplit: options.fromSplit ?? false,
    canDouble: legal.has('double'),
    canSplit: legal.has('split'),
    peekedNotBlackjack: upcardRank === 'A' || compIndex(dealerUpcard.rank) === 9,
  };
  const ev = evaluateActions(input);
  return { input, ev, recommendation, explanation: explain({ evInput: input, ev, recommendation }) };
}

/** Every string the player can be shown, as one blob. */
function allProse(explanation: Explanation): string {
  return [
    explanation.headline,
    explanation.summary,
    explanation.detail,
    explanation.advancedNote,
    explanation.approximationNote,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
}

// --- Shape and safety ------------------------------------------------------

describe('explain — output shape', () => {
  it('names the recommended action in the headline', () => {
    expect(situation(['T', '2'], '4').explanation.headline).toBe('Stand.');
    expect(situation(['5', '6'], '6').explanation.headline).toBe('Double.');
    expect(situation(['8', '8'], 'T').explanation.headline).toBe('Split.');
    expect(situation(['9', '7'], 'T').explanation.headline).toBe('Hit.');
  });

  it('always fills headline, summary and detail', () => {
    for (const explanation of everyCoveredSituation()) {
      expect(explanation.headline.length).toBeGreaterThan(0);
      expect(explanation.summary.length).toBeGreaterThan(0);
      // A sheet the player expands has to say something, not just restate the
      // headline it was opened from.
      expect(explanation.detail.length).toBeGreaterThan(40);
    }
  });

  it('never leaks an unfilled placeholder or a bad number', () => {
    for (const explanation of everyCoveredSituation()) {
      const prose = allProse(explanation);
      expect(prose).not.toMatch(/undefined|NaN|null|\{|\}|\[object/);
      // A number that reached prose without going through a formatter shows up
      // as a long decimal tail. Every real figure here is an integer plus ¢ or %.
      expect(prose).not.toMatch(/\d\.\d{3}/);
    }
  });

  it('has no doubled spaces or empty sentences from a dropped clause', () => {
    for (const explanation of everyCoveredSituation()) {
      const prose = allProse(explanation);
      expect(prose).not.toMatch(/ {2}/);
      expect(prose).not.toMatch(/\.\s*\./);
    }
  });
});

// --- Coverage of every reason code -----------------------------------------

/**
 * One real hand per reason code. These are situations, not fixtures: the code
 * each produces is asserted, so a chart edit that moves a cell out from under
 * its reason breaks here rather than silently changing what a player is told.
 */
const CODE_SAMPLES: Readonly<Record<Exclude<ReasonCode, 'INSURANCE_IS_A_SUCKER_BET'>, {
  readonly player: readonly Rank[];
  readonly up: Rank;
}>> = {
  CANT_BUST_ALWAYS_HIT: { player: ['3', '5'], up: 'T' },
  DEALER_WEAK_LET_THEM_BUST: { player: ['T', '3'], up: '5' },
  DEALER_STRONG_MUST_IMPROVE: { player: ['T', '5'], up: '7' },
  SOFT_HAND_CANT_BUST: { player: ['A', '4'], up: 'T' },
  DOUBLE_WHEN_DEALER_LIKELY_BUSTS: { player: ['5', '4'], up: '5' },
  DOUBLE_STRONG_TOTAL: { player: ['6', '5'], up: '9' },
  STAND_ON_A_MADE_HAND: { player: ['T', '9'], up: '9' },
  SPLIT_TWO_HANDS_BEAT_ONE: { player: ['7', '7'], up: '3' },
  ALWAYS_SPLIT_ACES: { player: ['A', 'A'], up: '9' },
  ALWAYS_SPLIT_EIGHTS: { player: ['8', '8'], up: 'T' },
  NEVER_SPLIT_TENS: { player: ['T', 'T'], up: '6' },
  NEVER_SPLIT_FIVES: { player: ['5', '5'], up: '6' },
  CLOSEST_CALL: { player: ['T', '2'], up: '4' },
  DAMAGE_CONTROL: { player: ['T', '6'], up: 'T' },
};

function everyCoveredSituation(): readonly Explanation[] {
  return Object.values(CODE_SAMPLES).map((sample) => situation(sample.player, sample.up).explanation);
}

describe('explain — reason code coverage', () => {
  it('every reason code has prose, with no code left unreachable', () => {
    const covered = new Set<ReasonCode>(['INSURANCE_IS_A_SUCKER_BET']);
    for (const [code, sample] of Object.entries(CODE_SAMPLES)) {
      const { recommendation } = situation(sample.player, sample.up);
      // The sample must actually produce the code it is filed under, or the
      // template it is meant to exercise is never run.
      expect(recommendation.reasonCode).toBe(code);
      covered.add(recommendation.reasonCode);
    }
    expect([...covered].sort()).toEqual([...REASON_CODES].sort());
  });

  it('produces distinct copy for every code', () => {
    const summaries = everyCoveredSituation().map((e) => e.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });
});

// --- The worked example from SPEC §5.4 -------------------------------------

describe('explain — 12 vs 4, the worked example', () => {
  const { explanation, ev } = situation(['T', '2'], '4');

  it('recommends standing and frames it as the cheaper loss', () => {
    expect(explanation.headline).toBe('Stand.');
    // This cell is filed under CLOSEST_CALL, not DAMAGE_CONTROL — 12 vs 4 is the
    // narrowest stand on the chart. The cheaper-loss framing has to survive that
    // routing, because SPEC §5.4 uses this exact hand to demonstrate it.
    expect(explanation.detail).toMatch(/cheaper loss/);
  });

  it('quotes the dealer bust rate the EV calculator actually used', () => {
    // SPEC §5.4 quotes "about 40%" for a dealer 4. The prose must carry the
    // live number, so this asserts the band rather than a literal string.
    const match = /busts about (\d+)% of the time/.exec(explanation.detail);
    expect(match).not.toBeNull();
    const quoted = Number(match?.[1]);
    expect(quoted).toBeGreaterThanOrEqual(38);
    expect(quoted).toBeLessThanOrEqual(42);
  });

  it('quotes both action costs, and both really are losses', () => {
    expect(ev.stand).toBeLessThan(0);
    expect(ev.hit).toBeLessThan(0);
    const standCents = Math.round(Math.abs(ev.stand) * 100);
    const hitCents = Math.round(Math.abs(ev.hit) * 100);
    expect(explanation.detail).toContain(`Standing loses ${standCents}¢ per dollar`);
    expect(explanation.detail).toContain(`hitting loses ${hitCents}¢`);
  });
});

// --- Damage control, the idea the app is for -------------------------------

describe('explain — the damage-control framing', () => {
  it('says you lose either way only when both actions really lose', () => {
    const losing = situation(['T', '6'], 'T').explanation.detail;
    expect(losing).toMatch(/lose money on this hand either way/);
    expect(losing).toMatch(/cheaper loss/);
  });

  it('does not claim a loss when the recommended action is profitable', () => {
    const winning = situation(['T', '9'], '6');
    expect(winning.ev.stand).toBeGreaterThan(0);
    expect(winning.explanation.detail).not.toMatch(/lose money on this hand either way/);
    expect(allProse(winning.explanation)).toMatch(/wins \d+¢/);
  });

  it('reports the gap on the closest call rather than pretending it is clear', () => {
    const { explanation, ev } = situation(['T', '2'], '4');
    const gap = Math.abs(ev.stand - ev.hit);
    expect(gap).toBeLessThan(0.05);
    expect(explanation.summary).toMatch(/genuinely close/);
  });
});

// --- Fallbacks and the advanced note ---------------------------------------

describe('explain — when the book answer is unavailable', () => {
  it('says the book wanted to double, and that it is not on offer', () => {
    // 5,4 vs 5 is a double, but a seat that cannot match its bet may only hit.
    const { recommendation, explanation } = situation(['5', '4'], '5', { availableFunds: 0 });
    expect(recommendation.fallback).toBe(true);
    expect(recommendation.action).toBe('hit');
    expect(explanation.headline).toBe('Hit.');
    expect(explanation.detail).toMatch(/^The book wants to double here/);
  });

  it('says nothing about fallbacks when the book answer was available', () => {
    const { explanation } = situation(['5', '4'], '5');
    expect(explanation.detail).not.toMatch(/The book wants/);
  });

  it('names the split the book wanted when the four-hand limit is reached', () => {
    const { recommendation, explanation } = situation(['8', '8'], 'T', { handCount: 4 });
    expect(recommendation.fallback).toBe(true);
    expect(explanation.detail).toMatch(/^The book wants to split here/);
  });
});

describe('explain — the advanced note (SPEC §5.3)', () => {
  it('is absent when the chart and the numbers agree', () => {
    expect(situation(['T', '6'], '5').explanation.advancedNote).toBeNull();
  });

  it('appears, without changing the headline, when they disagree', () => {
    // Hard 16 against a ten out of three or more small cards is the best-known
    // composition-dependent play in the game, and the one cell the
    // cross-validation test records as a genuine disagreement.
    const { explanation, ev, recommendation } = situation(['4', '5', '7'], 'T');
    expect(recommendation.action).toBe('hit');
    expect(explanation.headline).toBe('Hit.');
    if (ev.best !== recommendation.action) {
      expect(explanation.advancedNote).toMatch(/Advanced: /);
      expect(explanation.advancedNote).toMatch(/chart's answer is the one to learn/);
    } else {
      expect(explanation.advancedNote).toBeNull();
    }
  });
});

// --- The split approximation label -----------------------------------------

describe('explain — split approximation', () => {
  it('labels the split figure wherever one exists', () => {
    const { explanation } = situation(['8', '8'], 'T');
    expect(explanation.approximationNote).toMatch(/approximate/);
  });

  it('says nothing about splits on a hand that cannot split', () => {
    const { explanation } = situation(['T', '6'], 'T');
    expect(explanation.approximationNote).toBeNull();
  });
});

// --- Insurance -------------------------------------------------------------

describe('explainInsurance', () => {
  const explanation = explainInsurance(freshShoeComposition(6), VEGAS_STRIP);

  it('declines, and quotes the real cost', () => {
    expect(explanation.headline).toBe('Decline insurance.');
    expect(explanation.detail).toMatch(/loses \d+¢/);
  });

  it('states the price and the break-even it fails to meet', () => {
    expect(explanation.detail).toContain('2:1');
    expect(explanation.detail).toContain('33%');
    // 96 of 312 cards in a fresh six-deck shoe are ten-value.
    expect(explanation.detail).toContain('31%');
  });

  it('names even money as the same bet', () => {
    expect(explanation.detail).toMatch(/[Ee]ven money/);
  });

  it('survives an exhausted shoe rather than dividing by zero', () => {
    const empty = new Array(10).fill(0) as unknown as Composition;
    const prose = allProse(explainInsurance(empty, VEGAS_STRIP));
    expect(prose).not.toMatch(/NaN|Infinity/);
  });
});

// --- Number formatting -----------------------------------------------------

describe('explain — number formatting', () => {
  it('never rounds a real chance to 0% or 100%', () => {
    // A hand where the dealer bust chance is small but not zero: the prose must
    // not claim it cannot happen.
    const { explanation } = situation(['T', '6'], 'A');
    expect(allProse(explanation)).not.toMatch(/\b0%|\b100%/);
  });

  it('expresses money in whole cents per dollar', () => {
    for (const explanation of everyCoveredSituation()) {
      for (const match of allProse(explanation).matchAll(/(\d+)¢/g)) {
        expect(Number(match[1])).toBeGreaterThan(0);
      }
    }
  });
});
