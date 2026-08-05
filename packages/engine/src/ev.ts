/**
 * Composition-dependent expected value (SPEC §5.2).
 *
 * Every number produced here is enumerated from the cards actually left in the
 * shoe against the dealing rules. Nothing in this file knows what basic
 * strategy says, and it must stay that way: `strategy.ts` is written
 * independently and the two are checked against each other (SPEC §8, "EV ↔
 * chart cross-validation"). A chart smuggled in here would make the highest
 * value test in the project assert nothing.
 *
 * Hands are carried as `(hard, anyAce)` — the hard total with every ace counted
 * as one, plus whether any ace is present — rather than as a total plus a
 * `soft` flag. Only one ace can ever count as eleven, so the pair is a complete
 * description, and it is the form that survives repeated draws: demoting an ace
 * and clearing a `soft` flag forgets that a *second* ace can still ride high,
 * which visibly inflates the dealer's bust rate on an ace upcard. `handTotal`
 * in `hand.ts` demotes from the top for the same reason and the two agree;
 * `ev.test.ts` asserts that agreement rather than assuming it.
 *
 * Two approximations, both deliberate, both measured, and both documented at
 * the site that makes them: the dealer distribution is fixed at the decision
 * point rather than recomputed after every card the player draws, and a split
 * is valued as two independent hands that never resplit.
 */

import { compIndex, type Card, type CompIndex, type Composition, type MutableComposition } from './cards.js';
import { isBlackjack, isPair, type Action } from './hand.js';
import type { RuleSet } from './rules.js';

/** Probability the dealer finishes on each total. Sums to 1. */
export type DealerDistribution = {
  readonly p17: number;
  readonly p18: number;
  readonly p19: number;
  readonly p20: number;
  readonly p21: number;
  readonly pBust: number;
  /** Natural. Zero when `peekedNotBlackjack`, since that branch was eliminated. */
  readonly pBlackjack: number;
};

export type EvInput = {
  readonly rules: RuleSet;
  /** Unseen cards remaining — already excludes player cards and the dealer upcard. */
  readonly composition: Composition;
  readonly playerCards: readonly Card[];
  readonly dealerUpcard: Card;
  /** This hand came from a split, so it can never be a natural. */
  readonly fromSplit: boolean;
  readonly canDouble: boolean;
  readonly canSplit: boolean;
  /** The dealer peeked and does not have a natural. */
  readonly peekedNotBlackjack: boolean;
};

/** Expected value of each action, in units of the ORIGINAL bet.
 *  Doubling therefore ranges over [-2, +2]. `null` = the action is not available. */
export type ActionEv = {
  readonly stand: number;
  readonly hit: number;
  readonly double: number | null;
  readonly split: number | null;
  /** The highest-EV available action. */
  readonly best: Action;
  readonly bestEv: number;
};

// --- bucket arithmetic -----------------------------------------------------

/**
 * The ten composition buckets as a typed list. Iterating this rather than
 * `for (let i = 0; i < 10; i++)` is what keeps `comp[i]` a `number` instead of
 * `number | undefined` under `noUncheckedIndexedAccess`.
 */
const BUCKETS: readonly CompIndex[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Bucket value with the ace counted *low*. Deliberately not `compIndexValue`,
 * which counts the ace as eleven: the running accumulator here is a hard total,
 * and the eleven is added back once, at the end, only if it fits.
 */
const HARD_VALUE: readonly [
  number, number, number, number, number,
  number, number, number, number, number,
] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Best total for a `(hard, anyAce)` pair. Identical to `handTotal(...).total`. */
function bestTotal(hard: number, anyAce: boolean): number {
  return anyAce && hard + 10 <= 21 ? hard + 10 : hard;
}

/** True when an ace is still counted as eleven. Identical to `handTotal(...).soft`. */
function isSoft(hard: number, anyAce: boolean): boolean {
  return anyAce && hard + 10 <= 21;
}

function countCards(composition: Composition): number {
  let total = 0;
  for (const i of BUCKETS) total += composition[i];
  return total;
}

function mutableCopy(composition: Composition): MutableComposition {
  return [
    composition[0], composition[1], composition[2], composition[3], composition[4],
    composition[5], composition[6], composition[7], composition[8], composition[9],
  ];
}

// --- dealer enumeration ----------------------------------------------------

/**
 * Internal dealer distribution: indices 0..4 are totals 17..21, 5 is bust,
 * 6 is a natural. A flat array rather than the public object because the hit
 * recursion reads it thousands of times per call and object property loads on
 * a frozen shape are not free on Hermes.
 */
type DealerVector = Float64Array;

const DEALER_SLOTS = 7;
const BUST_SLOT = 5;
const NATURAL_SLOT = 6;

/**
 * A dealer hand that can never be completed, because the shoe ran dry mid-draw
 * or because the caller conditioned on an impossible event (an ace upcard, a
 * peek that found no natural, and nothing but tens left). `dealCard` throws on
 * a genuinely exhausted shoe, so this is unreachable in play; the EV calculator
 * still has to return a normalised distribution rather than NaN, and "the
 * dealer never makes a hand" is the reading closest to bust.
 */
function unresolvable(): DealerVector {
  const vector = new Float64Array(DEALER_SLOTS);
  vector[BUST_SLOT] = 1;
  return vector;
}

/**
 * Enumerate every dealer draw sequence from `(hard, anyAce)`, accumulating
 * `weight` into the terminal bucket. `composition` is mutated in place and
 * restored on the way out — the alternative, copying a ten-element array at
 * every one of the ~20k nodes a two-upcard reaches, dominates the runtime.
 */
function enumerateDraws(
  hard: number,
  anyAce: boolean,
  composition: MutableComposition,
  remaining: number,
  weight: number,
  accumulator: DealerVector,
  dealerHitsSoft17: boolean,
): void {
  const soft = isSoft(hard, anyAce);
  const total = bestTotal(hard, anyAce);

  if (total > 21) {
    accumulator[BUST_SLOT] = (accumulator[BUST_SLOT] ?? 0) + weight;
    return;
  }
  // The stopping rule, read off the rule set rather than hardcoded: stand on
  // 17+, except a soft 17 under H17. Mirrors `dealerShouldHit` exactly.
  if (total >= 17 && !(total === 17 && soft && dealerHitsSoft17)) {
    const slot = total - 17;
    accumulator[slot] = (accumulator[slot] ?? 0) + weight;
    return;
  }
  if (remaining === 0) {
    accumulator[BUST_SLOT] = (accumulator[BUST_SLOT] ?? 0) + weight;
    return;
  }

  for (const i of BUCKETS) {
    const count = composition[i];
    if (count === 0) continue;
    composition[i] = count - 1;
    enumerateDraws(
      hard + HARD_VALUE[i],
      anyAce || i === 0,
      composition,
      remaining - 1,
      weight * (count / remaining),
      accumulator,
      dealerHitsSoft17,
    );
    composition[i] = count;
  }
}

/**
 * The hole card is enumerated separately from the draws that follow it because
 * it is the only card that can make a natural, and because it is the card the
 * peek conditions on.
 */
function computeDealerVector(
  upcard: CompIndex,
  composition: Composition,
  peekedNotBlackjack: boolean,
  rules: RuleSet,
): DealerVector {
  const working = mutableCopy(composition);
  const remaining = countCards(composition);
  const accumulator = new Float64Array(DEALER_SLOTS);

  // The one hole card that would pair with this upcard for a natural.
  const naturalHole: CompIndex | null = upcard === 0 ? 9 : upcard === 9 ? 0 : null;

  // Conditioning on "the dealer peeked and has no natural" removes that hole
  // card from the sample space entirely and renormalises what is left. Only the
  // *hole* card's distribution changes: once it is fixed, the dealer draws from
  // the real remaining shoe, so every deeper denominator stays `remaining - 1`.
  // Getting this wrong shifts every ace-upcard and ten-upcard number.
  const removed = peekedNotBlackjack && naturalHole !== null ? composition[naturalHole] : 0;
  const holeCards = remaining - removed;
  if (holeCards <= 0) return unresolvable();

  for (const hole of BUCKETS) {
    const count = working[hole];
    if (count === 0) continue;

    if (hole === naturalHole) {
      if (peekedNotBlackjack) continue; // eliminated by the peek
      // A natural ends the hand where it stands; the dealer draws no further.
      accumulator[NATURAL_SLOT] = (accumulator[NATURAL_SLOT] ?? 0) + count / holeCards;
      continue;
    }

    working[hole] = count - 1;
    enumerateDraws(
      HARD_VALUE[upcard] + HARD_VALUE[hole],
      upcard === 0 || hole === 0,
      working,
      remaining - 1,
      count / holeCards,
      accumulator,
      rules.dealerHitsSoft17,
    );
    working[hole] = count;
  }

  return accumulator;
}

/**
 * Memo across calls, keyed on everything the enumeration reads. A session deals
 * a new composition on nearly every decision, so an unbounded map would grow
 * for as long as the app runs; clearing wholesale on overflow is O(1) amortised
 * and costs less bookkeeping than LRU eviction would save, because the entries
 * worth keeping are the handful from the round in progress.
 */
const DEALER_CACHE_LIMIT = 4096;
const dealerCache = new Map<string, DealerVector>();

function dealerCacheKey(
  upcard: CompIndex,
  composition: Composition,
  peekedNotBlackjack: boolean,
  rules: RuleSet,
): string {
  // Counts never exceed 16 per deck, so each fits a code unit. Only
  // `dealerHitsSoft17` of the rule set reaches the enumeration, so only it is
  // keyed — if another dealer rule is ever added it must be added here too.
  return String.fromCharCode(
    upcard,
    peekedNotBlackjack ? 1 : 0,
    rules.dealerHitsSoft17 ? 1 : 0,
    composition[0], composition[1], composition[2], composition[3], composition[4],
    composition[5], composition[6], composition[7], composition[8], composition[9],
  );
}

function dealerVector(
  upcard: CompIndex,
  composition: Composition,
  peekedNotBlackjack: boolean,
  rules: RuleSet,
): DealerVector {
  const key = dealerCacheKey(upcard, composition, peekedNotBlackjack, rules);
  const cached = dealerCache.get(key);
  if (cached !== undefined) return cached;

  const vector = computeDealerVector(upcard, composition, peekedNotBlackjack, rules);
  if (dealerCache.size >= DEALER_CACHE_LIMIT) dealerCache.clear();
  dealerCache.set(key, vector);
  return vector;
}

/** Drop every memoised dealer distribution. Exposed for benchmarks and tests. */
export function clearEvCaches(): void {
  dealerCache.clear();
}

/**
 * Distribution over dealer final totals.
 * `composition` is the unseen cards: it must already exclude the upcard,
 * the player's cards, and any other cards the caller counts as seen.
 * `peekedNotBlackjack` conditions the distribution on the dealer having
 * already peeked and not held a natural.
 */
export function dealerOutcomes(
  upcard: CompIndex,
  composition: Composition,
  peekedNotBlackjack: boolean,
  rules: RuleSet,
): DealerDistribution {
  const vector = dealerVector(upcard, composition, peekedNotBlackjack, rules);
  return {
    p17: vector[0] ?? 0,
    p18: vector[1] ?? 0,
    p19: vector[2] ?? 0,
    p20: vector[3] ?? 0,
    p21: vector[4] ?? 0,
    pBust: vector[BUST_SLOT] ?? 0,
    pBlackjack: vector[NATURAL_SLOT] ?? 0,
  };
}

// --- standing --------------------------------------------------------------

/**
 * Stand EV for every reachable player total, precomputed once per dealer
 * distribution. The hit recursion asks for this a few thousand times per call
 * and the answer depends only on the total, so paying for it once is free.
 * Index is the total; anything above 21 is a bust and worth -1 outright.
 */
function buildStandTable(dealer: DealerVector): Float64Array {
  const table = new Float64Array(22);
  const natural = dealer[NATURAL_SLOT] ?? 0;
  const bust = dealer[BUST_SLOT] ?? 0;

  for (let total = 0; total <= 21; total++) {
    // A dealer natural beats every hand the player can stand on, including a
    // non-natural 21. Dealer bust wins for any player hand that is still alive.
    let ev = bust - natural;
    for (let dealerTotal = 17; dealerTotal <= 21; dealerTotal++) {
      const p = dealer[dealerTotal - 17] ?? 0;
      if (total > dealerTotal) ev += p;
      else if (total < dealerTotal) ev -= p;
    }
    table[total] = ev;
  }
  return table;
}

function standAt(table: Float64Array, total: number): number {
  return total > 21 ? -1 : table[total] ?? -1;
}

// --- the player's recursion ------------------------------------------------

/**
 * Value of a hand played optimally from here: `max(evStand, evHit)`, which is
 * the right thing for a hit to be compared against.
 *
 * Memoised on `(hard, anyAce, composition)`. Every ordering of the same drawn
 * cards collapses to one entry, which takes a hard-four start from ~370k
 * visited nodes down to ~1.1k distinct ones. The map is per-call, so a stale
 * shoe can never leak into a later hand.
 *
 * The dealer distribution baked into `stand` is the one computed at the
 * decision point and is *not* recomputed as the player draws. That is an
 * approximation — cards the player takes are genuinely unavailable to the
 * dealer — and it is the one place this file trades exactness for speed.
 * Measured against a fully exact version that re-enumerates the dealer at every
 * node, the error is ≤ 2e-4 for a two-card start and ≤ 7e-4 for the deepest
 * post-split hand, against action margins that are never tighter than ~3e-3.
 * That exact version costs 500-850ms per call; this one costs ~1.7ms at its
 * worst. The 50ms budget rules the exact version out by two orders of
 * magnitude, not by a hair.
 */
function playValue(
  hard: number,
  anyAce: boolean,
  composition: MutableComposition,
  remaining: number,
  stand: Float64Array,
  memo: Map<string, number>,
): number {
  const total = bestTotal(hard, anyAce);
  if (total > 21) return -1;

  const key = String.fromCharCode(
    hard,
    anyAce ? 1 : 0,
    composition[0], composition[1], composition[2], composition[3], composition[4],
    composition[5], composition[6], composition[7], composition[8], composition[9],
  );
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let value = standAt(stand, total);
  // Standing is forced on 21 and on an empty shoe. Hitting a 21 is never
  // correct anyway, and `legalActions` does not offer it.
  if (total < 21 && remaining > 0) {
    let hit = 0;
    for (const i of BUCKETS) {
      const count = composition[i];
      if (count === 0) continue;
      composition[i] = count - 1;
      hit +=
        (count / remaining) *
        playValue(hard + HARD_VALUE[i], anyAce || i === 0, composition, remaining - 1, stand, memo);
      composition[i] = count;
    }
    if (hit > value) value = hit;
  }

  memo.set(key, value);
  return value;
}

/** One card, then optimal play. Bust scores -1 through `playValue`. */
function hitValue(
  hard: number,
  anyAce: boolean,
  composition: MutableComposition,
  remaining: number,
  stand: Float64Array,
): number {
  // No card to deal: hitting degenerates to standing rather than to a loss.
  if (remaining === 0) return standAt(stand, bestTotal(hard, anyAce));

  const memo = new Map<string, number>();
  let ev = 0;
  for (const i of BUCKETS) {
    const count = composition[i];
    if (count === 0) continue;
    composition[i] = count - 1;
    ev +=
      (count / remaining) *
      playValue(hard + HARD_VALUE[i], anyAce || i === 0, composition, remaining - 1, stand, memo);
    composition[i] = count;
  }
  return ev;
}

/**
 * Exactly one card, then stand, at twice the stake. A bust stands on a busted
 * total, worth -1, which the doubling turns into the -2 the rules require —
 * no separate bust branch needed.
 */
function doubleValue(
  hard: number,
  anyAce: boolean,
  composition: Composition,
  remaining: number,
  stand: Float64Array,
): number {
  if (remaining === 0) return 2 * standAt(stand, bestTotal(hard, anyAce));

  let ev = 0;
  for (const i of BUCKETS) {
    const count = composition[i];
    if (count === 0) continue;
    const drawnHard = hard + HARD_VALUE[i];
    const drawnAce = anyAce || i === 0;
    ev += (count / remaining) * standAt(stand, bestTotal(drawnHard, drawnAce));
  }
  return 2 * ev;
}

/**
 * Value of splitting, counting BOTH resulting hands, in units of the original
 * bet. It is compared directly against the one-hand value of not splitting,
 * which is the comparison the chart itself is derived from: splitting risks two
 * units to collect two outcomes.
 *
 * The documented resplit simplification (SPEC §5.2 permits one; SPEC §5.3 has
 * the UI label the number approximate): exactly two hands are valued, and each
 * is valued against the full post-split composition as though its sibling did
 * not exist. So a pair that could be split again is instead played out as a
 * normal hand, and the two hands do not compete for cards.
 *
 * The two errors push in opposite directions and neither is large. Forbidding
 * the resplit understates splitting — most visibly for aces and eights, where
 * it comes to a few percent of the split EV — while ignoring the sibling's
 * consumption of the shoe overstates it by considerably less. The net is a
 * conservative number: this file will under-recommend splitting slightly rather
 * than over-recommend it, which is the safer direction for advice.
 *
 * Modelling resplits properly means valuing up to four hands drawn from one
 * shared shoe, with the count of hands already taken as part of the state. That
 * is a categorically larger computation than anything else here and does not
 * fit the budget.
 */
function splitValue(
  pairIndex: CompIndex,
  composition: MutableComposition,
  remaining: number,
  stand: Float64Array,
  rules: RuleSet,
): number {
  const splitAces = pairIndex === 0 && rules.oneCardToSplitAces;
  if (remaining === 0) return 2 * standAt(stand, bestTotal(HARD_VALUE[pairIndex], pairIndex === 0));

  const memo = new Map<string, number>();
  let perHand = 0;

  for (const i of BUCKETS) {
    const count = composition[i];
    if (count === 0) continue;
    composition[i] = count - 1;

    const hard = HARD_VALUE[pairIndex] + HARD_VALUE[i];
    const anyAce = pairIndex === 0 || i === 0;

    let value: number;
    if (splitAces) {
      // One card each and the hand is over: no hit, no double, and a 21 here is
      // not a natural, so it is valued as a plain 21 (SPEC §2).
      value = standAt(stand, bestTotal(hard, anyAce));
    } else {
      value = playValue(hard, anyAce, composition, remaining - 1, stand, memo);
      if (rules.doubleAfterSplit) {
        const doubled = doubleValue(hard, anyAce, composition, remaining - 1, stand);
        if (doubled > value) value = doubled;
      }
    }

    perHand += (count / remaining) * value;
    composition[i] = count;
  }

  return 2 * perHand;
}

// --- public entry points ---------------------------------------------------

export function evaluateActions(input: EvInput): ActionEv {
  const { rules, composition, playerCards, dealerUpcard, fromSplit, peekedNotBlackjack } = input;

  const upcard = compIndex(dealerUpcard.rank);
  const dealer = dealerVector(upcard, composition, peekedNotBlackjack, rules);
  const stand = buildStandTable(dealer);
  const natural = dealer[NATURAL_SLOT] ?? 0;

  let hard = 0;
  let anyAce = false;
  for (const card of playerCards) {
    const bucket = compIndex(card.rank);
    hard += HARD_VALUE[bucket];
    anyAce = anyAce || bucket === 0;
  }
  const total = bestTotal(hard, anyAce);

  const working = mutableCopy(composition);
  const remaining = countCards(composition);

  // A natural is paid at the blackjack rate and only pushes against a dealer
  // natural, so standing on one is worth well over 1.0 — treating it as an
  // ordinary 21 would quietly understate every pat-hand comparison.
  const [payoutNumerator, payoutDenominator] = rules.blackjackPayout;
  const standEv = isBlackjack(playerCards, fromSplit)
    ? (1 - natural) * (payoutNumerator / payoutDenominator)
    : standAt(stand, total);

  const hitEv = hitValue(hard, anyAce, working, remaining, stand);

  // The caller's flags decide availability, but doubling and splitting are
  // first-decision actions by definition, so the shape of the hand vetoes them.
  const doubleEv =
    input.canDouble && playerCards.length === 2
      ? doubleValue(hard, anyAce, working, remaining, stand)
      : null;

  const first = playerCards[0];
  const splitEv =
    input.canSplit && isPair(playerCards) && first !== undefined
      ? splitValue(compIndex(first.rank), working, remaining, stand, rules)
      : null;

  // Ties resolve to the earlier action in this fixed order, which keeps the
  // recommendation deterministic and prefers the cheaper wager when two are
  // genuinely worth the same.
  let best: Action = 'stand';
  let bestEv = standEv;
  if (hitEv > bestEv) {
    best = 'hit';
    bestEv = hitEv;
  }
  if (doubleEv !== null && doubleEv > bestEv) {
    best = 'double';
    bestEv = doubleEv;
  }
  if (splitEv !== null && splitEv > bestEv) {
    best = 'split';
    bestEv = splitEv;
  }

  return { stand: standEv, hit: hitEv, double: doubleEv, split: splitEv, best, bestEv };
}

/** EV of taking insurance, per unit of the insurance stake (half the base bet). */
export function insuranceEv(composition: Composition, rules: RuleSet): number {
  const remaining = countCards(composition);
  // No unseen cards means no chance of the ten that pays; the stake is simply
  // lost. Guarded rather than divided, so the caller never sees a NaN.
  if (remaining === 0) return -1;

  // Insurance is a flat bet on the hole card being a ten. Nothing about the
  // player's hand enters into it, which is exactly why it is a sucker bet at
  // any composition where tens are not over-represented (SPEC §5.3).
  const tenDensity = composition[9] / remaining;
  const [numerator, denominator] = rules.insurancePayout;
  return tenDensity * (1 + numerator / denominator) - 1;
}
