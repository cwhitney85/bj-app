/**
 * Money, in cents.
 *
 * **Every monetary quantity in this engine is a number of cents.** Bankrolls,
 * bets, payouts, nets, table limits, and the money figures on the report card.
 * Nothing anywhere is a number of dollars, and the only place dollars exist is
 * in a formatter at the edge of the UI.
 *
 * ### Why cents rather than dollars
 *
 * M1 decision 3 chose exact, unrounded money — a $5 natural returns $12.50 — and
 * the first implementation held that in IEEE doubles. Those two choices do not
 * work together. `12.5 - 2 * 5` evaluates to `2.4999999999999996`, so any code
 * that subtracted a stake back out of a payout got an answer that was wrong in
 * the fifteenth decimal place and stayed wrong. The app had begun growing
 * `Math.round(x * 100) / 100` helpers to paper over it, which is rounding
 * arriving through the back door in the one engine that promised not to.
 *
 * Integers do not have that failure mode. The promise "nothing is rounded" is
 * now true by construction rather than by intention.
 *
 * ### The two kinds of quantity, and why both are cents
 *
 * - **Integer cents — money that actually moved.** A bankroll, a bet, a payout,
 *   a net. `Number.isInteger` holds for every one of these at every instant, and
 *   `PLAYABLE_BET` below is what keeps it true through settlement.
 * - **Real cents — an expectation.** `Decision.moneyDelta` is `evDelta × stake`:
 *   a dimensionless ratio times a number of cents. It is not money anybody paid,
 *   so it is not an integer, and rounding it would be inventing precision in one
 *   direction and destroying it in the other.
 *
 * Both are cents so that the *unit* is uniform. The alternative — money in cents
 * and expectations in dollars — makes the one line where they meet
 * (`sessionReport`'s `evLost`) a place where a missing `× 100` produces a report
 * that is off by two orders of magnitude and entirely plausible.
 *
 * ### Why `Cents` is an alias and not a branded type
 *
 * A brand would catch a dollars-for-cents mix-up at compile time, which is
 * exactly the mistake a migration like this can introduce — so it was
 * considered and rejected on how TypeScript actually behaves. Arithmetic on a
 * branded number *erases the brand*: `bankroll - bet` is a plain `number`, so
 * every assignment in the engine would need re-branding. That is noise on
 * hundreds of sites in exchange for safety only at the boundaries, and boundary
 * safety is what the tests and the simulation harness already provide — the
 * house edge is a ratio and is therefore invariant under this change, so a mixed
 * unit anywhere moves it out of band.
 *
 * The alias documents the unit. It does not enforce it, and pretending
 * otherwise would be worse than being clear about it.
 */

/**
 * A number of cents.
 *
 * Documentation, not enforcement — see the module note above. Read it as "this
 * number is in cents", and read a bare `number` in a money context as a bug.
 */
export type Cents = number;

/** One dollar. The only conversion constant, so there is one place to be wrong. */
export const DOLLAR: Cents = 100;

/** Cents to dollars, for a formatter at the UI edge. Never used for arithmetic. */
export function toDollars(cents: Cents): number {
  return cents / DOLLAR;
}

/**
 * The granularity a bet must satisfy for settlement to stay exact.
 *
 * **Derived, not chosen.** Two payouts halve the stake and nothing else does:
 * a natural at 3:2 returns `stake + 3 × stake / 2`, and insurance stakes half
 * the base bet. Doubling, splitting, and insurance's own 2:1 payout on a
 * half-stake all preserve integrality on their own. So the weakest rule that
 * keeps every derived amount a whole number of cents is that the stake be even.
 *
 * It is deliberately the *weakest* such rule rather than the tidiest. "Whole
 * dollars" or "multiples of the $5 chip" would also work and are easier to say,
 * but a precondition should constrain a caller as little as the property
 * requires — and a seat pushing out the last of a bankroll that has been through
 * a 3:2 payout genuinely holds an odd-dollar amount like $18.75.
 */
export const PLAYABLE_BET: Cents = 2;

/** Whether an amount can be staked without making any payout fractional. */
export function isPlayableBet(amount: Cents): boolean {
  return Number.isInteger(amount) && amount % PLAYABLE_BET === 0;
}

/**
 * The largest playable bet not exceeding `amount`.
 *
 * For a seat resolving an intent against what it actually holds. Rounds *down*,
 * always: pushing out more than the bankroll is the one direction that is not a
 * rounding question but an overdraft.
 */
export function largestPlayableBet(amount: Cents): Cents {
  return Math.floor(amount / PLAYABLE_BET) * PLAYABLE_BET;
}
