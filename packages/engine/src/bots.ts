/**
 * Bot policies (SPEC §6).
 *
 * A policy is a pure function of the *public* view: `(view) => Action`. Two
 * properties are load-bearing and neither is negotiable.
 *
 * **Policies see only `view.ts`'s projection.** They cannot reach the hole card,
 * so a bot never plays a hand it could not have played at a real table.
 *
 * **Policies draw no random numbers.** Every decision is a deterministic
 * function of the cards on the table. The randomness SPEC §6 asks for lives in
 * *which* seat gets *which* personality — drawn once, from a derived seed, by
 * `assignJerk` — not inside the decisions themselves. That is what makes the
 * counterfactual replay (SPEC §7) trustworthy without threading an RNG stream
 * through every call: re-running a seat under a different policy cannot perturb
 * any other seat's stream, because there is no stream.
 *
 * The jerk personalities are not uniform noise. Each is one specific, widely
 * held, genuinely costly habit, so a player watching the table recognises the
 * mistake rather than seeing a bot flail.
 */

import { dealerShouldHit, handTotal, type Action, type LegalActionContext } from './hand.js';
import { mulberry32, deriveSeed } from './rng.js';
import { recommend, recommendInsurance } from './strategy.js';
import type { ActionView, InsuranceView } from './view.js';

export type BotPolicy = {
  readonly id: string;
  /** Short name for the UI. */
  readonly label: string;
  /** One line describing the habit, in the player's language. */
  readonly description: string;
  /**
   * Choose an action.
   *
   * Postcondition: the result is an element of `view.legalActions`. A policy
   * that violates this is a bug in the policy; `decideAction` below is the
   * chokepoint that says so by name rather than letting `applyAction` throw a
   * message that does not mention which bot was at fault.
   */
  act(view: ActionView): Action;
  takeInsurance(view: InsuranceView): boolean;
};

// --- Shared helpers --------------------------------------------------------

/**
 * The book answer for this hand.
 *
 * `contextOverride` exists for exactly one purpose — see `NEVER_SPLITS` — and
 * is deliberately narrow: it can only make an action *less* available, by
 * describing a seat with fewer resources than it really has. It can never
 * conjure an action the seat could not take, because `recommend` guarantees its
 * result is in `legalActions(hand, context)` for the context it was given, and
 * a context claiming fewer resources yields a subset of the real legal actions.
 */
function bookAction(view: ActionView, contextOverride?: Partial<LegalActionContext>): Action {
  const context: LegalActionContext = { ...view.context, ...contextOverride };
  return recommend(view.hand, view.table.dealerUpcard, context).action;
}

/** The first of `preferred` that is legal, else the book answer. */
function prefer(view: ActionView, ...preferred: readonly Action[]): Action {
  for (const action of preferred) {
    if (view.legalActions.includes(action)) return action;
  }
  return bookAction(view);
}

const DECLINES_INSURANCE = (): boolean => recommendInsurance().take;

// --- The policy every bot uses unless told otherwise -----------------------

/**
 * Calls the same strategy engine the player is being taught (SPEC §6). Not a
 * copy of it — a copy would let the bots stay right while the lesson went
 * wrong, which is the one failure this app cannot afford.
 */
export const PERFECT_POLICY: BotPolicy = {
  id: 'perfect',
  label: 'By the book',
  description: 'Plays perfect basic strategy on every hand.',
  act: (view) => bookAction(view),
  takeInsurance: DECLINES_INSURANCE,
};

// --- Jerk personalities (SPEC §6) ------------------------------------------

/**
 * Perfect play with one exception: always buys insurance. The purest version
 * of the mistake, because nothing else about the hand is wrong — the money
 * leaks entirely through a side bet the player thinks is protection.
 */
const ALWAYS_INSURES: BotPolicy = {
  id: 'always-insures',
  label: 'Better safe than sorry',
  description: 'Takes insurance every single time it is offered.',
  act: (view) => bookAction(view),
  takeInsurance: () => true,
};

/**
 * Hits every hard 16, including 8,8 — which the chart splits. "Sixteen never
 * wins" is the folk theory, and hitting it is the most-argued-about play at a
 * real table.
 */
const HITS_EVERY_16: BotPolicy = {
  id: 'hits-every-16',
  label: 'Sixteen never wins',
  description: 'Hits every hard 16, whatever the dealer is showing.',
  act: (view) => {
    const { total, soft } = handTotal(view.hand.cards);
    if (total === 16 && !soft) return prefer(view, 'hit');
    return bookAction(view);
  },
  takeInsurance: DECLINES_INSURANCE,
};

/**
 * Never splits anything — not aces, not eights.
 *
 * Implemented by telling `recommend` the seat is already at its resplit limit.
 * That is not a trick for its own sake: it routes the hand through
 * `strategy.ts`'s existing denied-split fallthrough, which plays a pair as the
 * hard or soft total it actually is *and* reports the fallback cell's reason
 * code. That is precisely the habit, on a path that is already tested. Writing
 * a second pair-to-total rule here would be a second thing to keep correct.
 */
const NEVER_SPLITS: BotPolicy = {
  id: 'never-splits',
  label: 'One hand is enough',
  description: 'Never splits a pair — not even aces or eights.',
  act: (view) => bookAction(view, { handCount: view.table.rules.maxHands }),
  takeInsurance: DECLINES_INSURANCE,
};

/**
 * Stands on soft 17 (A,6) because "seventeen is a hand". It is the one total
 * that cannot be hurt by a card — the ace simply demotes — so standing throws
 * away a free draw every time.
 */
const STANDS_ON_SOFT_17: BotPolicy = {
  id: 'stands-on-soft-17',
  label: 'Seventeen is a hand',
  description: 'Stands on soft 17, giving up a draw that cannot bust.',
  act: (view) => {
    const { total, soft } = handTotal(view.hand.cards);
    if (total === 17 && soft) return prefer(view, 'stand');
    return bookAction(view);
  },
  takeInsurance: DECLINES_INSURANCE,
};

/**
 * Doubles hard 12 "because it feels right". Doubling is only legal on the first
 * two cards, so this fires on 10,2 / 9,3 / 8,4 / 7,5 and on a pair of 6s, where
 * it doubles instead of splitting.
 */
const DOUBLES_TWELVE: BotPolicy = {
  id: 'doubles-twelve',
  label: 'Feels right',
  description: 'Doubles a hard 12 whenever it can.',
  act: (view) => {
    const { total, soft } = handTotal(view.hand.cards);
    if (total === 12 && !soft) return prefer(view, 'double');
    return bookAction(view);
  },
  takeInsurance: DECLINES_INSURANCE,
};

/**
 * Plays the dealer's own policy: draw below 17, stand otherwise, never double,
 * never split, never insure. "The house wins, so I'll play like the house."
 *
 * It is the most expensive habit in this list and the reason is worth stating
 * once: the mimic busts about as often as the dealer, but busts *first*, so the
 * dealer keeps every hand they both lose — and the mimic is never paid 3:2 for
 * a natural.
 *
 * `dealerShouldHit` is the real dealer rule, read from the rule set, so the
 * mimic follows S17 or H17 automatically rather than hardcoding one of them.
 */
const MIMICS_DEALER: BotPolicy = {
  id: 'mimics-dealer',
  label: 'Play like the house',
  description: 'Copies the dealer: draws to 17, never doubles, never splits.',
  act: (view) =>
    dealerShouldHit(view.hand.cards, view.table.rules)
      ? prefer(view, 'hit', 'stand')
      : prefer(view, 'stand', 'hit'),
  takeInsurance: DECLINES_INSURANCE,
};

/** The bad habits SPEC §6 names, in a stable order — the seed indexes into it. */
export const JERK_POLICIES: readonly BotPolicy[] = [
  ALWAYS_INSURES,
  HITS_EVERY_16,
  NEVER_SPLITS,
  STANDS_ON_SOFT_17,
  DOUBLES_TWELVE,
  MIMICS_DEALER,
];

export const ALL_POLICIES: readonly BotPolicy[] = [PERFECT_POLICY, ...JERK_POLICIES];

/**
 * Resolve a `SeatOccupant`'s `policyId`. Throws on an unknown id rather than
 * defaulting to perfect play: a typo that silently produces a competent bot is
 * invisible, and it would quietly disable Jerk Mode.
 */
export function policyById(id: string): BotPolicy {
  const policy = ALL_POLICIES.find((candidate) => candidate.id === id);
  if (policy === undefined) throw new Error(`Unknown bot policy "${id}"`);
  return policy;
}

// --- Choosing the jerk -----------------------------------------------------

export type JerkAssignment = {
  readonly seat: number;
  readonly policy: BotPolicy;
};

/**
 * Pick exactly one seat to play badly, and which habit it has (SPEC §6).
 *
 * The stream is derived from the game seed with its own label, so it is
 * independent of the shuffle: turning Jerk Mode on or off, or changing which
 * habit is drawn, cannot change a single card. Returns `null` when there are no
 * bot seats to assign — a table of one is not a bug.
 */
export function assignJerk(seed: number, botSeats: readonly number[]): JerkAssignment | null {
  if (botSeats.length === 0) return null;
  const rng = mulberry32(deriveSeed(seed, 'jerk'));
  const seat = botSeats[rng.nextInt(botSeats.length)];
  const policy = JERK_POLICIES[rng.nextInt(JERK_POLICIES.length)];
  if (seat === undefined || policy === undefined) {
    throw new Error('assignJerk: index out of range'); // unreachable: bounds are the array lengths
  }
  return { seat, policy };
}

// --- Invoking a policy -----------------------------------------------------

/**
 * Ask a policy to act and enforce its postcondition.
 *
 * `applyAction` would reject an illegal action anyway, but its message names
 * the seat, not the policy. When six personalities are in play, "policy
 * 'mimics-dealer' chose double" is the difference between a one-line fix and a
 * debugging session.
 */
export function decideAction(policy: BotPolicy, view: ActionView): Action {
  const action = policy.act(view);
  if (!view.legalActions.includes(action)) {
    throw new Error(
      `Policy "${policy.id}" chose illegal action "${action}" for seat ${view.seat.index} ` +
        `hand ${view.handIndex}; legal: ${view.legalActions.join(', ')}`,
    );
  }
  return action;
}
