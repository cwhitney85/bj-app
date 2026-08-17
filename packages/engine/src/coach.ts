/**
 * The coaching facade (SPEC §5) — one call from a prompt to everything the hint
 * layer renders, and one call from a tap to what it cost.
 *
 * Every piece already exists: `knowledge.ts` decides what the calculator may
 * know, `strategy.ts` gives the book answer, `ev.ts` prices the alternatives and
 * `explain.ts` turns the pair into prose. Nothing joined them, so a screen
 * wanting a hint had to wire all four itself. That is the wrong place for the
 * assembly for two reasons:
 *
 * 1. **`knownCards` (SPEC §5.3) is a game decision, not a view decision.** It is
 *    the difference between reading the table and counting cards. A view layer
 *    that picks it is a view layer deciding how strong the app's advice is.
 * 2. **The chart-vs-EV disagreement has one correct resolution** — the chart
 *    keeps the headline, the disagreement renders as an advanced note (SPEC
 *    §5.3). `explain.ts` already encodes that. A caller assembling the parts by
 *    hand can get it wrong, and the failure mode is a beginner being told two
 *    different things.
 *
 * So this module owns the wiring, and it owns nothing else. It computes no
 * probability, writes no sentence and makes no recommendation of its own; it
 * calls four functions in the one correct order. `test/coach.test.ts` pins that
 * by hand-wiring the same four calls and asserting the results are identical —
 * if this file ever starts deciding something, that test breaks.
 *
 * Deviation pricing lives here too (`assess`), because it is the same question
 * asked after the fact: the EV numbers are already on the table, and comparing
 * two of them is not something the report card should be re-deriving from a
 * composition it would have to rebuild.
 */

import type { Composition } from './cards.js';
import { evaluateActions, insuranceEv, type ActionEv, type EvInput } from './ev.js';
import type { Cents } from './money.js';
import { explain, explainInsurance, type Explanation } from './explain.js';
import { handTotal, type Action } from './hand.js';
import { unseenComposition, type KnownCards } from './knowledge.js';
import type { SessionStep } from './session.js';
import { dealerUpcard, type RoundState } from './state.js';
import {
  recommend,
  recommendInsurance,
  type ReasonCode,
  type Recommendation,
} from './strategy.js';
import { actionView, insuranceView } from './view.js';

/**
 * How much the coach is allowed to know (SPEC §5.3). One field, because that is
 * genuinely the entire difference between the two modes.
 */
export type CoachSettings = {
  readonly knownCards: KnownCards;
};

/** The default. Only what is face up this round — not card counting. */
export const PURE_PLAY: CoachSettings = { knownCards: 'current-round' };

/** Opt-in, advanced. Every card dealt since the shuffle (SPEC §5.3, M7). */
export const COUNTING: CoachSettings = { knownCards: 'full-shoe' };

/**
 * Everything the hint card, the EV bars and the explanation sheet need for one
 * action decision.
 *
 * `evInput` travels with `ev` for the same reason `ExplainInput` pairs them
 * (M2 decision 17): the bars, the prose and any later comparison must all quote
 * numbers derived from one composition, and keeping the input beside the result
 * is what makes recomputing one of them against a different composition awkward
 * to write.
 */
export type ActionCoaching = {
  readonly kind: 'action';
  /** The book answer. Always the headline (SPEC §5.1). */
  readonly recommendation: Recommendation;
  /** EV of each legal action, in units of the base bet. */
  readonly ev: ActionEv;
  readonly explanation: Explanation;
  /** Exactly what `ev` was computed from. */
  readonly evInput: EvInput;
  /** The bet on the hand being decided, in cents — what an EV difference is priced in. */
  readonly stake: Cents;
};

/**
 * The insurance offer, which is not a decision about the player's hand at all,
 * and so carries no `ActionEv` and no hand-specific recommendation.
 */
export type InsuranceCoaching = {
  readonly kind: 'insurance';
  /** Always false: insurance is never correct under basic strategy (SPEC §5.4). */
  readonly take: boolean;
  readonly reasonCode: ReasonCode;
  /** EV per dollar of insurance stake. */
  readonly ev: number;
  readonly explanation: Explanation;
  /** The insurance stake in cents — half the base bet under every MVP rule set. */
  readonly stake: Cents;
  /** That stake as a fraction of the base bet, so `ev` can be put in base-bet units. */
  readonly cost: number;
  /** The unseen cards the number was computed over. */
  readonly composition: Composition;
};

export type Coaching = ActionCoaching | InsuranceCoaching;

// --- Entry points ----------------------------------------------------------

/**
 * Coach whatever the session is currently asking the player.
 *
 * Takes the whole `SessionStep` rather than a prompt and a state, so the two
 * cannot be mismatched: the state a `SessionStep` carries is by construction the
 * state its prompt was built from. A caller pairing a stale state with a fresh
 * prompt — a previous render's `session` in a closure, say — would get advice
 * about a hand that has already been split or resolved. Nothing would throw: the
 * result is a *valid* `Coaching`, with real numbers and grammatical prose, about
 * the wrong hand.
 *
 * Two adjacent concerns this does **not** address, named because they are easy
 * to merge with it:
 *
 * - **The state running ahead of the screen** is session.ts decision 34, and its
 *   fix lives in the table screen: render from drained events, never from
 *   `session.state`. Coaching is computed at the decision point and wants the
 *   state as of that point, which is exactly what a `SessionStep` carries.
 * - **The coach seeing what the player cannot** is `knowledge.ts` and the
 *   derivation in `peekedNotBlackjack` below. Pairing has nothing to do with
 *   secrecy.
 *
 * Returns `null` on a bet prompt. Bet-spread coaching is explicitly out of scope
 * for the MVP (SPEC §13), and there is nothing else honest to say about a stake
 * before a card is dealt.
 */
export function coach(step: SessionStep, settings: CoachSettings): Coaching | null {
  const { state, playerSeat } = step.session;
  switch (step.prompt.kind) {
    case 'bet':
      return null;
    case 'insurance':
      return coachInsurance(state, playerSeat, step.prompt.view.cost, settings);
    case 'action':
      return coachAction(state, playerSeat, settings);
  }
}

/**
 * Coach one seat's current hand.
 *
 * Precondition: the seat is acting and has at least one legal action —
 * `actionView` throws otherwise, and `recommend` throws on an empty action list.
 * Both are caller bugs and neither is papered over here: silently returning
 * "stand" for a resolved hand would put a fabricated recommendation in front of
 * a player who is being taught.
 */
export function coachAction(
  state: RoundState,
  seatIndex: number,
  settings: CoachSettings,
): ActionCoaching {
  const view = actionView(state, seatIndex);
  const recommendation = recommend(view.hand, view.table.dealerUpcard, view.context);

  const evInput: EvInput = {
    rules: state.rules,
    composition: unseenComposition(state, settings.knownCards),
    playerCards: view.hand.cards,
    dealerUpcard: view.table.dealerUpcard,
    fromSplit: view.hand.fromSplit,
    canDouble: view.legalActions.includes('double'),
    canSplit: view.legalActions.includes('split'),
    peekedNotBlackjack: peekedNotBlackjack(state),
  };
  const ev = evaluateActions(evInput);

  return {
    kind: 'action',
    recommendation,
    ev,
    explanation: explain({ evInput, ev, recommendation }),
    evInput,
    stake: view.hand.bet,
  };
}

/**
 * Coach the insurance offer. `cost` is the stake as a fraction of the base bet,
 * as `pendingDecision` reports it — 0.5 under every MVP rule set, but read from
 * the caller rather than assumed, because it is the rule set's number and not
 * this module's.
 */
export function coachInsurance(
  state: RoundState,
  seatIndex: number,
  cost: number,
  settings: CoachSettings,
): InsuranceCoaching {
  const view = insuranceView(state, seatIndex, cost);
  const composition = unseenComposition(state, settings.knownCards);
  const { take, reasonCode } = recommendInsurance();

  return {
    kind: 'insurance',
    take,
    reasonCode,
    ev: insuranceEv(composition, state.rules),
    explanation: explainInsurance(composition, state.rules),
    stake: view.seat.baseBet * cost,
    cost,
    composition,
  };
}

/**
 * Whether the dealer has already looked and does not hold a natural — the
 * condition `evaluateActions` prices the dealer's hand under.
 *
 * Derived from the shape of the round rather than read from
 * `state.dealer.hasBlackjack`. A dealer holding a natural settles the round at
 * the peek, so any seat that is being asked to act against a peekable upcard is
 * by construction facing a dealer who peeked and found nothing. Deriving it
 * keeps the coaching layer off the single field `view.ts` exists to censor: the
 * hint the player reads must never be computed from information the player
 * cannot have, or the app is teaching a line no one can reproduce at a table.
 */
function peekedNotBlackjack(state: RoundState): boolean {
  const upcard = dealerUpcard(state);
  if (upcard === undefined || !state.rules.dealerPeeks) return false;
  return upcard.rank === 'A' || handTotal([upcard]).total === 10;
}

// --- Deviation pricing -----------------------------------------------------

/**
 * What the player actually did. Mirrors the `Coaching` union so a mismatched
 * pair — an action assessed against an insurance offer — is a type the caller
 * has to go out of their way to build, and is rejected at runtime if they do.
 */
export type Choice =
  | { readonly kind: 'action'; readonly action: Action }
  | { readonly kind: 'insurance'; readonly take: boolean };

/**
 * One decision, scored against the book (SPEC §5.5, §9).
 *
 * **Sign convention, stated because inverting it would be invisible:** `evDelta`
 * is *chosen minus recommended*. Zero when the player followed the chart,
 * negative when the deviation cost them. The report card's "EV lost to
 * deviations" is therefore the negated sum of `moneyDelta`.
 *
 * `evDelta` can be *positive*. In the composition-dependent cells where the EV
 * calculator disagrees with the chart — a multi-card hard 16 against a ten is
 * the known one (see PLAN, cross-validation) — a deviation really is worth
 * marginally more. Reporting that honestly is the same commitment `explain.ts`
 * makes: no number in this app is allowed to lie in the app's own favour.
 */
export type Decision = {
  readonly choice: Choice;
  readonly wasRecommended: boolean;
  /** The reason code behind the book answer, for ranking mistakes by kind. */
  readonly reasonCode: ReasonCode;
  /** Chosen minus recommended, in units of the base bet. */
  readonly evDelta: number;
  /**
   * `evDelta` priced at this decision's stake, in cents.
   *
   * **Real cents, not integer cents, and deliberately so.** Every other money
   * figure in the engine is an integer because it is money that actually moved;
   * this one is `evDelta × stake` — a dimensionless ratio times a number of
   * cents — so it is an *expectation* and nobody ever paid it. Rounding it to
   * the cent would invent precision the ratio does not have and destroy the
   * exact-zero property `report.ts` decision 46 depends on. See money.ts for the
   * integer/real split and why both are cents.
   */
  readonly moneyDelta: Cents;
};

/**
 * Score a choice against the coaching the player was shown.
 *
 * Precondition: `choice.kind === coaching.kind`, and an action choice was legal
 * — i.e. it appears in the `legalActions` the same view offered. Both throw.
 * A deviation is never blocked and never scolded (SPEC §5.5), but an *illegal*
 * action is not a deviation, it is a caller bug, and scoring it would mean
 * inventing an EV for a move that could not be made.
 */
export function assess(coaching: Coaching, choice: Choice): Decision {
  if (coaching.kind === 'action') {
    if (choice.kind !== 'action') {
      throw new Error(`assess: ${choice.kind} choice against action coaching`);
    }
    const evDelta = evOf(coaching.ev, choice.action) - evOf(coaching.ev, coaching.recommendation.action);
    return {
      choice,
      wasRecommended: choice.action === coaching.recommendation.action,
      reasonCode: coaching.recommendation.reasonCode,
      evDelta,
      moneyDelta: evDelta * coaching.stake,
    };
  }

  if (choice.kind !== 'action') {
    // Declining is the book answer, so it is exactly free — not "very slightly
    // positive". Taking it is priced per dollar of the insurance stake, which is
    // a side bet rather than a fraction of the hand, so `evDelta` is scaled by
    // `cost` to reach the base-bet units every other number here uses.
    return {
      choice,
      wasRecommended: choice.take === coaching.take,
      reasonCode: coaching.reasonCode,
      evDelta: choice.take ? coaching.ev * coaching.cost : 0,
      moneyDelta: choice.take ? coaching.ev * coaching.stake : 0,
    };
  }

  throw new Error('assess: action choice against insurance coaching');
}

/**
 * A `null` here means the action was not available when the EV was computed, so
 * the player cannot have taken it. Named as a caller bug rather than treated as
 * zero, because zero would silently report a impossible move as free.
 */
function evOf(ev: ActionEv, action: Action): number {
  switch (action) {
    case 'stand':
      return ev.stand;
    case 'hit':
      return ev.hit;
    case 'double':
      if (ev.double === null) throw new Error('assess: double was not available on this hand');
      return ev.double;
    case 'split':
      if (ev.split === null) throw new Error('assess: split was not available on this hand');
      return ev.split;
    case 'surrender':
      throw new Error('assess: no MVP rule set offers surrender (SPEC §2)');
  }
}
