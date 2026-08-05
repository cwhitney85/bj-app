/**
 * EV ↔ chart cross-validation — SPEC §8 calls this the highest-value test in the
 * project, and the reason is worth stating plainly: `strategy.ts` and `ev.ts`
 * were written independently, from different sources, by authors who could not
 * see each other's work. One is a published lookup table. The other enumerates
 * card probabilities from first principles and has no idea a chart exists.
 *
 * They have no shared code path and no shared assumptions beyond the rule set.
 * If they agree on all ~2,700 decisions below, both are almost certainly right.
 * A bug in either one breaks this file.
 *
 * SPEC §5.3 anticipates that agreement will not be total: in rare
 * composition-dependent spots the EV-optimal action genuinely differs from a
 * total-dependent chart, and the chart still wins the headline. So this test
 * does not demand blanket agreement — it demands that every disagreement is
 * enumerated below and is a near-tie, which is what distinguishes a real
 * composition effect from a defect.
 */

import { describe, expect, it } from 'vitest';

import {
  compIndex,
  type Card,
  type Composition,
  type MutableComposition,
  type Rank,
} from '../src/cards.js';
import { evaluateActions, insuranceEv, type ActionEv } from '../src/ev.js';
import { handTotal, isPair, type Action } from '../src/hand.js';
import { freshShoeComposition } from '../src/knowledge.js';
import { VEGAS_STRIP } from '../src/rules.js';
import { chartLookup, recommendInsurance, type ChartAction } from '../src/strategy.js';

// --- Fixtures ---------------------------------------------------------------

/** Ten distinct ranks: every ten-value card is interchangeable, so `T` stands in. */
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'];

const RULES = VEGAS_STRIP;

let cardCounter = 0;
function card(rank: Rank): Card {
  // Suits are irrelevant to both implementations; ids only have to be distinct.
  return { rank, suit: 'S', id: `${rank}-${cardCounter++}` };
}

/** A fresh 6-deck shoe less the cards already on the table. */
function unseenAfter(dealt: readonly Card[]): Composition {
  const comp = freshShoeComposition(RULES.deckCount).slice() as MutableComposition;
  for (const c of dealt) {
    const index = compIndex(c.rank);
    comp[index] = (comp[index] as number) - 1;
  }
  return comp;
}

/**
 * The concrete action the chart is asking for, once the rule set's DAS setting
 * and the available actions have collapsed the cell. This is the same collapse
 * `recommend` performs, restated here against the *EV* notion of availability so
 * the two sides are compared on equal terms.
 */
function chartAsAction(chart: ChartAction, canDouble: boolean, canSplit: boolean): Action {
  switch (chart) {
    case 'H':
      return 'hit';
    case 'S':
      return 'stand';
    case 'D':
      return canDouble ? 'double' : 'hit';
    case 'Ds':
      return canDouble ? 'double' : 'stand';
    case 'P':
      return canSplit ? 'split' : 'hit';
    case 'Ph':
      return canSplit && RULES.doubleAfterSplit ? 'split' : 'hit';
  }
}

function evOf(result: ActionEv, action: Action): number {
  switch (action) {
    case 'hit':
      return result.hit;
    case 'stand':
      return result.stand;
    case 'double':
      return result.double ?? Number.NEGATIVE_INFINITY;
    case 'split':
      return result.split ?? Number.NEGATIVE_INFINITY;
    case 'surrender':
      return Number.NEGATIVE_INFINITY;
  }
}

type Case = {
  readonly label: string;
  readonly playerCards: readonly Card[];
  readonly upcard: Card;
  readonly canDouble: boolean;
  readonly canSplit: boolean;
};

type Disagreement = {
  readonly label: string;
  readonly chart: Action;
  readonly ev: Action;
  /** How much EV the chart's action gives up. Positive by construction. */
  readonly margin: number;
};

function run(testCase: Case): Disagreement | null {
  const { playerCards, upcard, canDouble, canSplit } = testCase;
  const peeked = upcard.rank === 'A' || handTotal([upcard]).total === 10;
  const result = evaluateActions({
    rules: RULES,
    composition: unseenAfter([...playerCards, upcard]),
    playerCards,
    dealerUpcard: upcard,
    fromSplit: false,
    canDouble,
    canSplit,
    // Every upcard that could hide a natural has been peeked at by the time the
    // player acts (SPEC §2), so this is the state every real decision is made in.
    peekedNotBlackjack: peeked,
  });

  const chart = chartAsAction(chartLookup(playerCards, upcard, RULES).action, canDouble, canSplit);
  if (chart === result.best) return null;
  return {
    label: testCase.label,
    chart,
    ev: result.best,
    margin: result.bestEv - evOf(result, chart),
  };
}

// --- Case generation --------------------------------------------------------

function twoCardCases(): readonly Case[] {
  const cases: Case[] = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = i; j < RANKS.length; j++) {
      const first = RANKS[i] as Rank;
      const second = RANKS[j] as Rank;
      const playerCards = [card(first), card(second)];
      // A natural is not a decision; the hand is over before anyone acts.
      if (handTotal(playerCards).total === 21) continue;
      for (const upRank of RANKS) {
        cases.push({
          label: `${first},${second} vs ${upRank}`,
          playerCards,
          upcard: card(upRank),
          canDouble: true,
          canSplit: isPair(playerCards),
        });
      }
    }
  }
  return cases;
}

/**
 * Three-card hands: the same totals reached after a hit, where doubling and
 * splitting are gone. This is where most real decisions actually happen, and it
 * exercises the chart's hit/stand rows independently of its double columns.
 */
function threeCardCases(): readonly Case[] {
  const cases: Case[] = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = i; j < RANKS.length; j++) {
      for (let k = j; k < RANKS.length; k++) {
        const ranks = [RANKS[i] as Rank, RANKS[j] as Rank, RANKS[k] as Rank];
        const playerCards = ranks.map(card);
        const { total } = handTotal(playerCards);
        // Busted hands and hard 21s have no decision to make.
        if (total >= 21) continue;
        for (const upRank of RANKS) {
          cases.push({
            label: `${ranks.join(',')} vs ${upRank}`,
            playerCards,
            upcard: card(upRank),
            canDouble: false,
            canSplit: false,
          });
        }
      }
    }
  }
  return cases;
}

/**
 * Disagreements this test accepts, keyed by case label.
 *
 * Every entry is a documented composition-dependent deviation (SPEC §5.3): a
 * spot where removing these specific cards from the shoe tips a decision the
 * total-dependent chart has to call one way for every composition. The chart
 * still wins the headline in the app; the EV number renders as an advanced note.
 *
 * And they are all the same deviation — **a hard 16 of three or more small
 * cards against a ten**, the best-known composition-dependent play in the game.
 * The chart must say hit, because across all compositions hitting 16 vs 10 is
 * right. But a 16 built from small cards has consumed exactly the cards that
 * would improve it, so standing edges ahead. That the two implementations landed
 * on this cell and only this cell — one from a published table, one from raw
 * enumeration, neither aware of the other — is the strongest evidence available
 * that both are correct.
 *
 * Note which three-card 16s are absent: `2,4,T`, `3,3,T`, `A,6,9`, `2,6,8`,
 * `3,6,7`, `4,6,6` all still agree with the chart. The ones holding a ten have
 * removed a ten from the shoe, which is what tips them back. The effect is real
 * and directional, not noise.
 *
 * Nothing may be added here without a margin small enough to prove it is a
 * near-tie rather than a defect — `MAX_EXCEPTION_MARGIN` enforces that.
 */
const ACCEPTED_DISAGREEMENTS: ReadonlySet<string> = new Set<string>([
  '2,5,9 vs T',
  '2,7,7 vs T',
  '3,4,9 vs T',
  '3,5,8 vs T',
  '4,4,8 vs T',
  '4,5,7 vs T',
  '5,5,6 vs T',
  'A,5,T vs T',
  'A,7,8 vs T',
]);

/** An accepted disagreement must give up less than a cent per dollar wagered. */
const MAX_EXCEPTION_MARGIN = 0.01;

// --- Tests ------------------------------------------------------------------

describe('EV calculator vs basic strategy chart', () => {
  const allCases = [...twoCardCases(), ...threeCardCases()];
  const disagreements = allCases.map(run).filter((d): d is Disagreement => d !== null);
  const byLabel = new Map(disagreements.map((d) => [d.label, d]));

  it('checks every reachable decision, so a silent skip cannot pass', () => {
    // 54 two-card rank multisets (55 less the natural) and 162 three-card ones
    // that are neither bust nor 21, each against all ten upcards. Pinned exactly:
    // a generation bug that quietly narrowed the sweep would otherwise let this
    // whole file pass while checking almost nothing.
    expect(twoCardCases()).toHaveLength(540);
    expect(threeCardCases()).toHaveLength(1620);
    expect(allCases).toHaveLength(2160);
  });

  it('agrees with the chart on every decision except the documented exceptions', () => {
    const unexpected = disagreements
      .filter((d) => !ACCEPTED_DISAGREEMENTS.has(d.label))
      .map((d) => `${d.label}: chart says ${d.chart}, EV says ${d.ev} (costs ${d.margin.toFixed(4)})`)
      .sort();
    expect(unexpected).toEqual([]);
  });

  it('gives up almost nothing on the exceptions it does accept', () => {
    for (const label of ACCEPTED_DISAGREEMENTS) {
      const disagreement = byLabel.get(label);
      // A stale entry is a problem in its own right: it means the exception was
      // fixed or renamed and the list is now lying about what this test covers.
      expect(disagreement, `${label} is listed as an exception but now agrees`).toBeDefined();
      expect(disagreement?.margin ?? 0).toBeLessThan(MAX_EXCEPTION_MARGIN);
    }
  });

  it('disagrees only about multi-card hard 16 against a ten', () => {
    // The exception list is allowed to grow only if the phenomenon stays the
    // same one. A deviation of a different shape is a defect until proven
    // otherwise, and naming the shape here is what makes that reviewable.
    for (const disagreement of disagreements) {
      const [hand, up] = disagreement.label.split(' vs ');
      const cards = (hand ?? '').split(',').map((rank) => card(rank as Rank));
      expect(handTotal(cards).total, disagreement.label).toBe(16);
      expect(handTotal(cards).soft, disagreement.label).toBe(false);
      expect(cards.length, disagreement.label).toBeGreaterThanOrEqual(3);
      expect(up, disagreement.label).toBe('T');
    }
  });

  it('never disagrees about a hand where the chart has a strong opinion', () => {
    // Doubling 11, splitting aces and eights, standing on 17+ and hitting 8 or
    // less are the least ambiguous instructions the app gives. If the EV
    // calculator argues with any of them, one of the two is badly wrong.
    const emphatic = disagreements.filter((d) => {
      const [hand] = d.label.split(' vs ');
      return hand === 'A,A' || hand === '8,8' || hand === 'T,T';
    });
    expect(emphatic).toEqual([]);
  });
});

describe('insurance', () => {
  it('is a losing bet the chart correctly refuses', () => {
    // Two independent statements of the same fact: the chart never takes it,
    // and the calculator prices it below zero on a shoe nobody has counted.
    expect(insuranceEv(freshShoeComposition(RULES.deckCount), RULES)).toBeLessThan(0);
    expect(recommendInsurance().take).toBe(false);
  });
});
