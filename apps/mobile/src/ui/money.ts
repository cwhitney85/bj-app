/**
 * Cents to something a player can read.
 *
 * **The only place in the app where money stops being cents.** The engine holds
 * every monetary quantity as a number of cents (money.ts) precisely so that no
 * arithmetic anywhere is done in dollars; the cost of that is one conversion,
 * and this module is it. A component doing its own `/ 100` is the beginning of
 * the second place, which is how the two drift.
 *
 * Formatting is a view concern and lives in the app rather than the engine for
 * the same reason `lessons.ts` does: the engine speaks in numbers, and how a
 * number is punctuated is a fact about the screen it is on.
 */

import { toDollars, type Cents } from '@bj/engine';

/**
 * `$25`, `$12.50`, `$0.00`.
 *
 * Whole dollars drop the cents because a felt covered in `.00` reads as a
 * spreadsheet. Anything with real cents in it keeps both digits — a $5 natural
 * pays $12.50 and abbreviating that to `$12` or `$13` would be the app
 * misreporting money it just paid.
 */
export function formatMoney(cents: Cents): string {
  const dollars = toDollars(Math.abs(cents));
  const body = Number.isInteger(dollars) ? `${dollars}` : dollars.toFixed(2);
  return `${cents < 0 ? '−' : ''}$${body}`;
}

/**
 * The same, with an explicit sign on positives: `+$25`, `−$12.50`.
 *
 * For anything that is a *result* rather than an amount — a hand's net, a
 * session's total. A bare `$25` beside a losing hand is ambiguous in exactly the
 * place the player is looking hardest.
 *
 * Uses U+2212 MINUS rather than a hyphen, matching `formatMoney`, so a negative
 * number is not read as a list item at small sizes.
 */
export function formatSignedMoney(cents: Cents): string {
  return cents < 0 ? formatMoney(cents) : `+${formatMoney(cents)}`;
}

/**
 * An expectation, to the cent: `$2.53`.
 *
 * Separate from `formatMoney` because `Decision.moneyDelta` and
 * `SessionReport.evLost` are *real* cents rather than integer cents (money.ts) —
 * nobody paid them, so they are not whole. Always two decimals, because dropping
 * them on a value that happens to land on a whole dollar would make an estimate
 * look like a settled amount.
 */
export function formatExpectation(cents: Cents): string {
  return `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
