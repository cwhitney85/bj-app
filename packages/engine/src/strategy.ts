/**
 * Basic strategy: the book answer, and what survives contact with legality.
 *
 * The tables below are the published Vegas Strip chart — 6 decks, S17, DAS, no
 * surrender (SPEC §2) — transcribed as one whitespace-separated string per
 * player total so they can be read straight down a column against a printed
 * chart. That legibility is the entire design of this file: a typo here does
 * not crash anything and no downstream test would obviously catch it, it just
 * silently teaches every user of the app a wrong lesson. The rows are expanded
 * and validated once at module load, so a malformed row fails at import rather
 * than mid-hand.
 *
 * Two cells are S17-specific and are the ones most often carried over from an
 * H17 chart by mistake: hard 11 hits against an ace rather than doubling, and
 * soft 18 stands against a 2 rather than doubling. Both are marked at the row.
 *
 * Two questions are answered separately and deliberately. `chartLookup` says
 * what the book wants. `recommend` says what this seat may actually do, because
 * the book's first choice is frequently unavailable — no funds to match the
 * bet, a third card already drawn, the four-hand split limit reached. Keeping
 * them apart is what lets the coaching layer say "the book doubles here, but
 * you cannot" instead of quietly presenting the fallback as the lesson.
 */

import { cardValue, type Card, type Rank } from './cards.js';
import {
  handTotal,
  isPair,
  legalActions,
  type Action,
  type Hand,
  type LegalActionContext,
} from './hand.js';
import type { RuleSet } from './rules.js';

/** `H` hit · `S` stand · `D` double else hit · `Ds` double else stand ·
 *  `P` split · `Ph` split if DAS else hit (SPEC §5.1). */
export type ChartAction = 'H' | 'S' | 'D' | 'Ds' | 'P' | 'Ph';

/**
 * Why a cell says what it says. These feed prose templates (SPEC §5.4), so the
 * code assigned to a cell must be the thing worth *saying* about it, not merely
 * a restatement of the action.
 *
 * Three codes are additions to the SPEC §5.4 list, each because a real family
 * of cells had nothing honest to say otherwise:
 *   - `DOUBLE_STRONG_TOTAL` — 10 vs 7-9 and 11 vs 7-10 double because the total
 *     is the edge, not because the dealer is in trouble.
 *   - `STAND_ON_A_MADE_HAND` — hard 18+, hard 17 vs 2-8, soft 19+, soft 18 vs
 *     7-8 and 9,9 vs 7: standing, because anything else can only make it worse.
 *   - `SPLIT_TWO_HANDS_BEAT_ONE` — every split that is not aces or eights.
 *
 * The list is a runtime array and the type is derived from it, the same way
 * `RANKS` works in cards.ts: `explain.ts` owes a prose template to every code,
 * and a union type alone can only prove that at compile time within one file.
 */
export const REASON_CODES = [
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
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export type ChartCell = { readonly action: ChartAction; readonly reasonCode: ReasonCode };

// --- Chart geometry --------------------------------------------------------

/**
 * Column in a chart row: dealer 2,3,4,5,6,7,8,9,T,A.
 *
 * The literal union earns its keep the same way `CompIndex` does in cards.ts —
 * a plain `number` index into the ten-element row tuple widens to
 * `ChartAction | undefined` under `noUncheckedIndexedAccess`, and every cell
 * read would need an assertion for a column that provably exists.
 */
type UpcardIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const UPCARD_INDEX: Readonly<Record<Rank, UpcardIndex>> = {
  '2': 0,
  '3': 1,
  '4': 2,
  '5': 3,
  '6': 4,
  '7': 5,
  '8': 6,
  '9': 7,
  T: 8,
  J: 8,
  Q: 8,
  K: 8,
  A: 9,
};

/** Named columns, so the reason-code rules below read as blackjack and not as arithmetic. */
const UP = {
  two: 0,
  three: 1,
  four: 2,
  six: 4,
  nine: 7,
  ace: 9,
} as const;

type ChartRow = readonly [
  ChartAction, ChartAction, ChartAction, ChartAction, ChartAction,
  ChartAction, ChartAction, ChartAction, ChartAction, ChartAction,
];

const CHART_ACTIONS: readonly ChartAction[] = ['H', 'S', 'D', 'Ds', 'P', 'Ph'];

/** Expand one chart row. Both the width and every token are checked, so the
 *  tuple assertion at the end is a fact rather than a hope. */
function row(spec: string): ChartRow {
  const tokens = spec.trim().split(/\s+/);
  const actions: ChartAction[] = [];
  for (const token of tokens) {
    const action = CHART_ACTIONS.find((candidate) => candidate === token);
    if (action === undefined) throw new Error(`Unknown chart action "${token}" in row: ${spec}`);
    actions.push(action);
  }
  if (actions.length !== 10) {
    throw new Error(`Chart row must have 10 cells, found ${actions.length}: ${spec}`);
  }
  return actions as unknown as ChartRow;
}

// --- The chart -------------------------------------------------------------

/**
 * Hard totals, no ace counted as 11.
 *
 * Row 4 exists only for a pair of deuces that cannot be split; the lowest total
 * reachable without a pair is 5.
 */
const HARD_CHART: Readonly<Record<number, ChartRow>> = {
  //          2    3    4    5    6    7    8    9    T    A
  4:  row('  H    H    H    H    H    H    H    H    H    H  '),
  5:  row('  H    H    H    H    H    H    H    H    H    H  '),
  6:  row('  H    H    H    H    H    H    H    H    H    H  '),
  7:  row('  H    H    H    H    H    H    H    H    H    H  '),
  8:  row('  H    H    H    H    H    H    H    H    H    H  '),
  9:  row('  H    D    D    D    D    H    H    H    H    H  '),
  10: row('  D    D    D    D    D    D    D    D    H    H  '),
  // 11 vs an ace hits, it does not double. That is S17-specific and it is the
  // most-questioned cell on this chart: standing the dealer on soft 17 removes
  // a whole round of dealer bust equity, and the extra bet stops paying for
  // itself. At an H17 table this cell doubles.
  11: row('  D    D    D    D    D    D    D    D    D    H  '),
  12: row('  H    H    S    S    S    H    H    H    H    H  '),
  13: row('  S    S    S    S    S    H    H    H    H    H  '),
  14: row('  S    S    S    S    S    H    H    H    H    H  '),
  15: row('  S    S    S    S    S    H    H    H    H    H  '),
  16: row('  S    S    S    S    S    H    H    H    H    H  '),
  17: row('  S    S    S    S    S    S    S    S    S    S  '),
  18: row('  S    S    S    S    S    S    S    S    S    S  '),
  19: row('  S    S    S    S    S    S    S    S    S    S  '),
  20: row('  S    S    S    S    S    S    S    S    S    S  '),
  21: row('  S    S    S    S    S    S    S    S    S    S  '),
};

/**
 * Soft totals, ace counted as 11. Row 12 is A,A that could not be split.
 *
 * The doubles form a ladder that is worth seeing as one shape: 13 and 14
 * against 5-6, 15 and 16 against 4-6, 17 and 18 against 3-6. Nothing soft ever
 * doubles against a 2, and nothing above 18 doubles at all — both of which are
 * S17 facts and both of which change under H17.
 */
const SOFT_CHART: Readonly<Record<number, ChartRow>> = {
  //          2    3    4    5    6    7    8    9    T    A
  12: row('  H    H    H    H    H    H    H    H    H    H  '),
  13: row('  H    H    H    D    D    H    H    H    H    H  '),
  14: row('  H    H    H    D    D    H    H    H    H    H  '),
  15: row('  H    H    D    D    D    H    H    H    H    H  '),
  16: row('  H    H    D    D    D    H    H    H    H    H  '),
  17: row('  H    D    D    D    D    H    H    H    H    H  '),
  // Soft 18 doubles against 3-6 only: against a 2 it stands. The other half of
  // the same S17 story as hard 11 vs ace — at an H17 table this cell is Ds.
  18: row('  S    Ds   Ds   Ds   Ds   S    S    H    H    H  '),
  19: row('  S    S    S    S    S    S    S    S    S    S  '),
  20: row('  S    S    S    S    S    S    S    S    S    S  '),
  21: row('  S    S    S    S    S    S    S    S    S    S  '),
};

/**
 * Pairs, keyed by the value of one card — 11 for aces, 10 for any ten-value
 * card, so K,Q reads as a pair of tens exactly as it splits at the table.
 *
 * The 5,5 and T,T rows are not split rows at all: fives are a hard 10 and tens
 * are a made 20, and saying so here rather than special-casing them at lookup
 * keeps the table the single place the chart lives.
 */
const PAIR_CHART: Readonly<Record<number, ChartRow>> = {
  //          2    3    4    5    6    7    8    9    T    A
  2:  row('  Ph   Ph   P    P    P    P    H    H    H    H  '),
  3:  row('  Ph   Ph   P    P    P    P    H    H    H    H  '),
  4:  row('  H    H    H    Ph   Ph   H    H    H    H    H  '),
  5:  row('  D    D    D    D    D    D    D    D    H    H  '),
  6:  row('  Ph   P    P    P    P    H    H    H    H    H  '),
  7:  row('  P    P    P    P    P    P    H    H    H    H  '),
  8:  row('  P    P    P    P    P    P    P    P    P    P  '),
  9:  row('  P    P    P    P    P    S    P    P    S    S  '),
  10: row('  S    S    S    S    S    S    S    S    S    S  '),
  11: row('  P    P    P    P    P    P    P    P    P    P  '),
};

function rowFor(chart: Readonly<Record<number, ChartRow>>, key: number, label: string): ChartRow {
  const found = chart[key];
  // Unreachable: every key is clamped into the table's range before lookup.
  if (found === undefined) throw new Error(`Strategy chart has no ${label} row for ${key}`);
  return found;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// --- Reason codes ----------------------------------------------------------

function hardReason(total: number, up: UpcardIndex, action: ChartAction): ReasonCode {
  // Against 2-6 the money goes in because the dealer is in trouble; against
  // 7-A (only 10 and 11 double there) it goes in because the total is the edge.
  if (action === 'D' || action === 'Ds') {
    return up <= UP.six ? 'DOUBLE_WHEN_DEALER_LIKELY_BUSTS' : 'DOUBLE_STRONG_TOTAL';
  }
  if (total <= 11) {
    // The one hit below 12 anybody argues about: 11 vs an ace is very nearly a
    // coin flip against doubling, and it *is* a double at an H17 table. Saying
    // "you can't bust" there would sound like the reason it isn't doubled.
    return total === 11 && up === UP.ace ? 'CLOSEST_CALL' : 'CANT_BUST_ALWAYS_HIT';
  }
  if (total >= 17) {
    // A hard 17 against 9, T or A is a loser however it is played — standing is
    // only the cheaper loss. 18 and up is a genuinely good hand.
    return total === 17 && up >= UP.nine ? 'DAMAGE_CONTROL' : 'STAND_ON_A_MADE_HAND';
  }
  // Stiff, 12-16.
  if (action === 'S') {
    // 12 vs 4 is the narrowest cell on the chart: standing wins by well under a
    // cent per dollar, and it is the one stand a beginner is right to question.
    return total === 12 && up === UP.four ? 'CLOSEST_CALL' : 'DEALER_WEAK_LET_THEM_BUST';
  }
  // Hitting a stiff into 9,T,A — or a 12 into a 2 or 3 — loses either way, and
  // the chart is choosing the cheaper loss. That reframing is the single most
  // useful idea the app transmits (SPEC §5.4).
  if (up >= UP.nine || (total === 12 && up <= UP.three)) return 'DAMAGE_CONTROL';
  return 'DEALER_STRONG_MUST_IMPROVE';
}

function softReason(total: number, up: UpcardIndex, action: ChartAction): ReasonCode {
  // A,7 vs 2 is the tightest cell on the soft chart — standing and doubling are
  // half a cent per dollar apart, and it flips to a double at an H17 table.
  if (total === 18 && up === UP.two) return 'CLOSEST_CALL';
  if (action === 'D' || action === 'Ds') return 'DOUBLE_WHEN_DEALER_LIKELY_BUSTS';
  if (action === 'S') return 'STAND_ON_A_MADE_HAND';
  return 'SOFT_HAND_CANT_BUST';
}

function pairReason(
  pairValue: number,
  up: UpcardIndex,
  action: ChartAction,
  cards: readonly Card[],
): ReasonCode {
  // The four pairs with a rule of their own get it whatever the column says.
  if (pairValue === 11) return 'ALWAYS_SPLIT_ACES';
  if (pairValue === 8) return 'ALWAYS_SPLIT_EIGHTS';
  if (pairValue === 10) return 'NEVER_SPLIT_TENS';
  if (pairValue === 5) return 'NEVER_SPLIT_FIVES';
  if (action === 'P' || action === 'Ph') return 'SPLIT_TWO_HANDS_BEAT_ONE';
  // Not splitting: the hand is just its total, so it borrows that cell's reason
  // rather than inventing a second explanation for the same decision.
  return totalCell(cards, up).reasonCode;
}

// --- Lookup ----------------------------------------------------------------

/** The hard or soft cell for these cards, ignoring any pair. Never yields P or Ph. */
function totalCell(cards: readonly Card[], up: UpcardIndex): ChartCell {
  const { total, soft } = handTotal(cards);
  if (soft) {
    const key = clamp(total, 12, 21);
    const action = rowFor(SOFT_CHART, key, 'soft')[up];
    return { action, reasonCode: softReason(key, up, action) };
  }
  // A busted or short hand cannot arise from a legal decision point, but
  // clamping keeps the lookup total rather than throwing at the coaching layer.
  const key = clamp(total, 4, 21);
  const action = rowFor(HARD_CHART, key, 'hard')[up];
  return { action, reasonCode: hardReason(key, up, action) };
}

function pairCell(pairRank: Rank, cards: readonly Card[], up: UpcardIndex): ChartCell {
  const pairValue = cardValue(pairRank);
  const action = rowFor(PAIR_CHART, pairValue, 'pair')[up];
  return { action, reasonCode: pairReason(pairValue, up, action, cards) };
}

/** The rank of a splittable pair, or null. K,Q counts as a pair of tens. */
function pairRankOf(cards: readonly Card[]): Rank | null {
  if (!isPair(cards)) return null;
  return cards[0]?.rank ?? null;
}

/**
 * Raw chart lookup: the book answer before legality is considered.
 *
 * `rules` selects the chart. Today there is exactly one — the 6-deck S17 DAS
 * table above — and every rule set gets it, but the parameter is in the
 * signature because basic strategy is only correct relative to a rule set
 * (SPEC §2) and an H17 table must be able to land here without touching a
 * single call site.
 */
export function chartLookup(
  playerCards: readonly Card[],
  dealerUpcard: Card,
  rules: RuleSet,
): ChartCell {
  void rules; // deliberately unread: one chart today, see the note above
  const up = UPCARD_INDEX[dealerUpcard.rank];
  const pairRank = pairRankOf(playerCards);
  if (pairRank !== null) return pairCell(pairRank, playerCards, up);
  return totalCell(playerCards, up);
}

// --- Resolution against legality -------------------------------------------

export type Recommendation = {
  /** Concrete action, guaranteed to be present in `legalActions(hand, context)`. */
  readonly action: Action;
  /** What the chart said, before legality collapsed it. */
  readonly chartAction: ChartAction;
  readonly reasonCode: ReasonCode;
  /** True when the chart's first choice was unavailable and the fallback was taken. */
  readonly fallback: boolean;
};

type Resolution = {
  readonly action: Action;
  readonly reasonCode: ReasonCode;
  readonly fallback: boolean;
};

/**
 * The book answer, resolved against what this hand may actually do right now.
 *
 * Throws when the hand has no legal actions — a resolved hand, or a split hand
 * still holding its single card. There is no sensible advice to give there and
 * silently returning `stand` would let a caller's bug reach the player.
 */
export function recommend(
  hand: Hand,
  dealerUpcard: Card,
  context: LegalActionContext,
): Recommendation {
  const legal = legalActions(hand, context);
  if (legal.length === 0) {
    throw new Error(
      'recommend: hand has no legal actions — it is already resolved, or it is a split hand ' +
        'still awaiting its second card. The caller should never have asked.',
    );
  }
  const cell = chartLookup(hand.cards, dealerUpcard, context.rules);
  const up = UPCARD_INDEX[dealerUpcard.rank];
  const resolved = resolveCell(cell, hand.cards, up, legal, context);
  return {
    action: resolved.action,
    chartAction: cell.action,
    reasonCode: resolved.reasonCode,
    fallback: resolved.fallback,
  };
}

/**
 * Collapse one chart cell onto a legal action.
 *
 * A denied split falls through to the hand's non-pair answer — a pair of 4s
 * that cannot be split is a hard 8, a pair of aces is a soft 12 — and that
 * answer is then collapsed by the same rules, because it may itself be a double
 * the seat cannot afford. This is the path a resplit-limited or short-bankrolled
 * seat genuinely takes, not an edge case. The recursion is one level deep by
 * construction: `totalCell` never returns P or Ph.
 */
function resolveCell(
  cell: ChartCell,
  cards: readonly Card[],
  up: UpcardIndex,
  legal: readonly Action[],
  context: LegalActionContext,
): Resolution {
  const can = (action: Action): boolean => legal.includes(action);
  const took = (action: Action): Resolution => ({
    action,
    reasonCode: cell.reasonCode,
    fallback: false,
  });
  // The chart's first choice was refused; take the named second choice, or —
  // unreachably, since stand is always legal on a live hand — anything legal.
  const instead = (action: Action): Resolution => ({
    action: can(action) ? action : firstLegal(legal),
    reasonCode: cell.reasonCode,
    fallback: true,
  });

  switch (cell.action) {
    case 'H':
      return can('hit') ? took('hit') : instead('stand');
    case 'S':
      return can('stand') ? took('stand') : instead('hit');
    case 'D':
      return can('double') ? took('double') : instead('hit');
    case 'Ds':
      return can('double') ? took('double') : instead('stand');
    case 'P':
    case 'Ph': {
      // `Ph` means "split if DAS else hit": with DAS off the chart itself
      // declines the split, so the non-pair answer is the book answer and not a
      // fallback. `legalActions` allows splitting regardless of DAS — it is a
      // rule about doubling — so the branch has to be taken here.
      const chartWantsSplit = cell.action === 'P' || context.rules.doubleAfterSplit;
      if (chartWantsSplit && can('split')) return took('split');
      const withoutSplitting = resolveCell(totalCell(cards, up), cards, up, legal, context);
      // The reason code comes from the fallback cell, not the pair cell: telling
      // someone to hit a hard 16 "because you always split eights" is nonsense.
      return {
        action: withoutSplitting.action,
        reasonCode: withoutSplitting.reasonCode,
        fallback: chartWantsSplit ? true : withoutSplitting.fallback,
      };
    }
  }
}

/** `legalActions` always lists stand first, so this fallback is deterministic. */
function firstLegal(legal: readonly Action[]): Action {
  const action = legal[0];
  if (action === undefined) throw new Error('recommend: no legal action to fall back on');
  return action;
}

// --- Insurance -------------------------------------------------------------

/**
 * Insurance is never correct under basic strategy (SPEC §2, §5.4). It is a
 * side bet on the hole card at 2:1 against roughly 9:4 odds, and it is not a
 * function of the player's hand — which is why this takes no arguments and why
 * "even money" on a natural is the same losing bet in a friendlier costume.
 */
export function recommendInsurance(): { readonly take: boolean; readonly reasonCode: ReasonCode } {
  return { take: false, reasonCode: 'INSURANCE_IS_A_SUCKER_BET' };
}
