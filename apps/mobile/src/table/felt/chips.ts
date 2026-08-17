/**
 * A bet, as the chips it is actually made of (SPEC §9's "physical chip stacks").
 *
 * SPEC §10 names four denominations and no others: $5, $25, $100, $500. That is
 * an art-pipeline decision, and it has a consequence this module refuses to hide
 * — **not every amount the engine can produce is expressible in them.** Insurance
 * is half a base bet, so a $5 bet insures for $2.50, and a natural pays $12.50 on
 * a $5 stake (M1 decision 3: nothing is rounded).
 *
 * So `chipsFor` returns what the stack really is *plus* what is left over, and
 * the caller prints the remainder as a number. The alternatives were both worse:
 * rounding would draw chips that add up to a different bet than the one placed,
 * and inventing a $1 chip would put a denomination on the felt that the art
 * direction does not have.
 */

export type ChipDenomination = 500 | 100 | 25 | 5;

/** Largest first, which is also bottom-of-stack first. */
export const CHIP_DENOMINATIONS: readonly ChipDenomination[] = [500, 100, 25, 5];

/**
 * Standard casino colours. Named here rather than in `theme.ts` because they are
 * not the app's palette — they are a fact about what a $25 chip looks like, and
 * a player who has seen a real table already knows them.
 */
export const CHIP_COLORS: Record<ChipDenomination, { readonly face: string; readonly edge: string }> = {
  500: { face: '#5b3a86', edge: '#e6dcf2' },
  100: { face: '#23272b', edge: '#d6dade' },
  25: { face: '#1f7a4d', edge: '#dff0e6' },
  5: { face: '#a8232f', edge: '#f4dcdf' },
};

/** One denomination and how many of it the stack holds. */
export type ChipRun = {
  readonly denomination: ChipDenomination;
  readonly count: number;
};

export type ChipStack = {
  /** Largest denomination first. Denominations with a count of zero are omitted. */
  readonly runs: readonly ChipRun[];
  /**
   * What no chip can express, in dollars: always less than the smallest
   * denomination, and always zero for a whole bet at this table's $5 minimum.
   * A caller that ignores this is drawing a stack worth less than the bet.
   */
  readonly remainder: number;
};

/**
 * Break an amount into chips, largest denomination first.
 *
 * Precondition (a caller bug, and thrown): `amount >= 0`. A negative bet is not
 * a stack of chips owed; it is a mistake upstream, and settling it silently here
 * would draw a pile where a seat has nothing on the felt.
 *
 * Postconditions, asserted in `test/chips.test.ts`:
 * - the runs sum, with `remainder`, to exactly `amount`;
 * - `0 <= remainder < 5`, the smallest denomination;
 * - runs are in strictly descending denomination order and never have a count of
 *   zero;
 * - greedy is minimal here, so no stack is taller than it has to be — every
 *   denomination divides the next one up, which is what makes that true.
 *
 * The floating-point rounding is deliberate and load-bearing. Money in this
 * engine is exact but not integral, and `12.5 - 2 * 5` in binary floating point
 * is `2.4999999999999996` — which would render a $2.50 remainder as `$2.50`
 * anyway and then fail an exact-sum test for a reason that has nothing to do
 * with chips. Cents are the smallest unit any of this deals in.
 */
export function chipsFor(amount: number): ChipStack {
  if (amount < 0) throw new Error(`chipsFor: an amount cannot be negative, got ${amount}`);

  const runs: ChipRun[] = [];
  let left = cents(amount);

  for (const denomination of CHIP_DENOMINATIONS) {
    const count = Math.floor(left / denomination);
    if (count > 0) {
      runs.push({ denomination, count });
      left = cents(left - count * denomination);
    }
  }

  return { runs, remainder: left };
}

/** Total chips in a stack — what the renderer needs to know before it draws one. */
export function chipCount(stack: ChipStack): number {
  return stack.runs.reduce((total, run) => total + run.count, 0);
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}
