/**
 * What the seat-select screen is choosing (SPEC §9).
 *
 * A `SeatDraft` is the table the player is laying out — where they sit, and
 * which of the other six chairs are occupied — and `configFrom` is the one place
 * a `TableConfig` is built from one.
 *
 * **The bot seats are chosen, not derived.** An earlier version took a bot
 * *count* and computed which chairs to fill. Any such rule is a guess about what
 * the player wants dressed up as an algorithm: seat order is not cosmetic
 * (SPEC §4) — it decides who acts before and after the player, which is the
 * premise of the third-base demo — so it is precisely the thing the player
 * should be choosing rather than inheriting. The rule is gone; the seats are a
 * set.
 *
 * **Why a draft type at all, rather than editing a `TableConfig` in place.**
 * `openTableState` has a precondition it cannot check: seating is fixed before a
 * card is dealt (shown.ts decision 56). A screen that edits a live `TableConfig`
 * satisfies that only by remembering to re-deal. A draft cannot violate it,
 * because a draft is not a table — nothing has been dealt from it yet.
 *
 * Note what is *not* here: who plays badly. That was a setup choice and is now a
 * table control, changeable at any moment (`setJerk` in tableState.ts), so it is
 * session state rather than seating.
 */

import { DOLLAR, type Cents, PURE_PLAY, VEGAS_STRIP, type CoachSettings } from '@bj/engine';

import type { TableConfig } from '../table/tableState';

export type SeatDraft = {
  /** `null` until the player has picked a chair. Nothing can be dealt before then. */
  readonly playerSeat: number | null;
  /** The chairs the player has filled with bots. Never contains `playerSeat`. */
  readonly botSeats: readonly number[];
};

export const SEAT_COUNT = VEGAS_STRIP.seatCount;
/** Every chair but the player's. */
export const MAX_BOTS = SEAT_COUNT - 1;

/** An empty table with nobody seated. The screen's starting point. */
export const EMPTY_DRAFT: SeatDraft = { playerSeat: null, botSeats: [] };

/** Play money, and the same for everyone at the table. $500, in cents (money.ts). */
const STARTING_BANKROLL: Cents = 500 * DOLLAR;
/** Bots flat-bet $25. Varying it is a bet-spread question, and SPEC §13 defers those. */
const BOT_BET: Cents = 25 * DOLLAR;

export function isSeat(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < SEAT_COUNT;
}

/** A draft with a seated player is one that can be dealt. */
export function canDeal(draft: SeatDraft): boolean {
  return draft.playerSeat !== null;
}

/**
 * Sit the player down, and clear the chair they took if a bot was in it.
 *
 * Invariant, maintained here and in `toggleBot`: `botSeats` never contains
 * `playerSeat`. Violating it would seat two occupants in one chair, and
 * `seating` resolves that by silently preferring the player — so the screen
 * would show a bot the dealt table does not have.
 */
export function sitAt(draft: SeatDraft, seat: number): SeatDraft {
  if (!isSeat(seat)) throw new Error(`sitAt: ${seat} is not one of the ${SEAT_COUNT} seats`);
  return {
    playerSeat: seat,
    botSeats: draft.botSeats.filter((index) => index !== seat),
  };
}

/** Stand up, leaving the bots where they are. */
export function standUp(draft: SeatDraft): SeatDraft {
  return { ...draft, playerSeat: null };
}

/**
 * Fill or empty one chair.
 *
 * Precondition: `seat` is a real chair and is not the player's — the caller
 * decides what tapping your own chair means, and this refuses to guess. Kept in
 * seating-chart order so the array reads like the table.
 */
export function toggleBot(draft: SeatDraft, seat: number): SeatDraft {
  if (!isSeat(seat)) throw new Error(`toggleBot: ${seat} is not one of the ${SEAT_COUNT} seats`);
  if (seat === draft.playerSeat) {
    throw new Error(`toggleBot: seat ${seat} is the player's — use sitAt or standUp`);
  }
  return {
    ...draft,
    botSeats: draft.botSeats.includes(seat)
      ? draft.botSeats.filter((index) => index !== seat)
      : [...draft.botSeats, seat].sort((a, b) => a - b),
  };
}

/**
 * Turn the laid-out table into the one to deal.
 *
 * Precondition: the player has taken a seat. Dealing a table the player is not
 * at is a caller bug — every per-seat figure the app renders is about *their*
 * seat — so it throws rather than picking one for them. `canDeal` is the check.
 *
 * `seed` is the caller's, not this function's: the engine forbids `Date.now()`
 * and this module is the app's, but a seed minted here would make every test of
 * a dealt table non-reproducible for no gain. The shell mints one per session;
 * the tests pass a constant.
 */
export function configFrom(
  draft: SeatDraft,
  seed: number,
  coachSettings: CoachSettings = PURE_PLAY,
): TableConfig {
  const { playerSeat, botSeats } = draft;
  if (playerSeat === null) {
    throw new Error('configFrom: the player has not taken a seat');
  }
  if (botSeats.includes(playerSeat)) {
    throw new Error(`configFrom: seat ${playerSeat} is both the player's and a bot's`);
  }

  return {
    seed,
    playerSeat,
    botSeats,
    bankroll: STARTING_BANKROLL,
    botBet: BOT_BET,
    coachSettings,
    // SPEC §6, and PLAN decision 76: a table deals with one bad player already
    // seated, because shipping the app's most valuable teaching feature switched
    // off and undiscovered is worse than shipping it on. What changed is that
    // the player can now move it or clear it at any moment — see `setJerk`.
    startWithJerk: botSeats.length > 0,
  };
}
