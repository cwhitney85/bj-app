/**
 * The table as the player has actually been shown it.
 *
 * `view.ts` censors the round by *seat* — what a player can see from their
 * chair. This module censors it by *time* — what the animation queue has drawn
 * so far. Same kind of object, different restriction, and this one exists
 * because of a promise the spec makes and nothing has ever checked.
 *
 * SPEC §4: "Each event carries everything the UI needs to render it without
 * querying back into the engine." SPEC §3 explains why that has to be true —
 * the UI drains events on its own clock, so `session.state` is the *future*,
 * not the felt. One `submitAction` can settle a round and deal into the next
 * (M4 decision 34), so a screen that renders from `session.state` shows the
 * player cards they have not been dealt yet.
 *
 * So the table screen must be a fold over the event stream, and that fold is
 * this. Two properties make it worth having as a module rather than as state
 * inside a component:
 *
 * 1. **It does no game math.** It never calls `handTotal`, `cardValue` or
 *    `legalActions`. Every number it holds was carried by an event. That is not
 *    stylistic — it is the whole point. A projection allowed to recompute would
 *    quietly cover for an event that forgot to carry something, and SPEC §4's
 *    promise would stay unchecked forever.
 *
 * 2. **Its correctness is an equality, not a judgement.** Fold every event a
 *    session has emitted and the result must equal `session.state`, seat for
 *    seat and card for card. `test/shown.test.ts` asserts exactly that, at every
 *    prompt, over many seeds and table layouts. A missing event field cannot
 *    pass it.
 *
 * The one thing it deliberately cannot reproduce is the hole card. It knows a
 * face-down card is *there* — `HoleCardPlaced` says so — and learns its identity
 * only at `HoleCardRevealed`. That is not a limitation to work around; it is the
 * same censorship `view.ts` performs, arrived at from the other direction, and
 * it is why `ShownCard` exists as a type.
 */

import type { Card } from './cards.js';
import type { GameEvent } from './events.js';
import type { Action } from './hand.js';
import type { HandOutcome } from './settle.js';
import type { Phase, Seat, SeatOccupant } from './state.js';

/**
 * A card on the felt. Face-down cards have no `card` field at all, so a renderer
 * cannot accidentally draw one — the same device `view.ts` uses on `TableView`.
 */
export type ShownCard = { readonly facing: 'up'; readonly card: Card } | { readonly facing: 'down' };

/**
 * One hand in front of one seat.
 *
 * `total` and `soft` are `null` between a split and the hand's second card
 * arriving: the engine deals that card lazily (M1 decision 4), and until it
 * lands no event has carried a total. Computing one here would be game math.
 * It renders as no total badge, which is also what a real table shows.
 */
export type ShownHand = {
  readonly cards: readonly Card[];
  readonly bet: number;
  readonly total: number | null;
  readonly soft: boolean;
  readonly fromSplit: boolean;
  readonly doubled: boolean;
  /**
   * The hand is finished and standing on its total.
   *
   * Not "the player tapped Stand" — `HandStood` is emitted for *any* hand that
   * finishes un-busted and un-doubled, including a natural and a split ace that
   * has taken its one card. `lastAction` is where a tap is recorded.
   */
  readonly standing: boolean;
  readonly busted: boolean;
  readonly surrendered: boolean;
  /** Set at settlement, for the chip animation; cleared when the felt clears. */
  readonly outcome: HandOutcome | null;
  readonly net: number | null;
};

export type ShownSeat = {
  readonly index: number;
  readonly occupant: SeatOccupant;
  readonly bankroll: number;
  readonly baseBet: number;
  readonly insuranceBet: number;
  readonly insuranceResolved: boolean;
  readonly hands: readonly ShownHand[];
  /** Which hand is acting, or -1. Drives the "you are here" highlight. */
  readonly activeHandIndex: number;
  /** The last action this seat took, for character reactions (SPEC §6, M5). */
  readonly lastAction: Action | null;
  /** Whether that action matched the book, when the coaching layer said so. */
  readonly lastActionWasRecommended: boolean | null;
};

export type ShownDealer = {
  readonly cards: readonly ShownCard[];
  /** The face-up total. Rises to the full total at `HoleCardRevealed`. */
  readonly total: number | null;
  readonly soft: boolean;
  readonly holeCardRevealed: boolean;
  readonly busted: boolean;
};

export type ShownTable = {
  readonly phase: Phase;
  readonly roundNumber: number;
  /** How far into the shoe: the discard tray's fill, and the cut card's approach. */
  readonly shoeIndex: number;
  readonly seats: readonly ShownSeat[];
  readonly dealer: ShownDealer;
  /** Seat currently acting, or -1. */
  readonly turnSeat: number;
  /** Legal actions for the acting hand, straight off `TurnStarted`. */
  readonly legalActions: readonly Action[];
  /** Seats still owing an insurance answer, or `null` when none is offered. */
  readonly insuranceOffer: readonly number[] | null;
  /** The cut card has been passed; the shoe is reshuffled at cleanup. */
  readonly shufflePending: boolean;
};

/**
 * The seating chart: the one thing no event carries, because it is not
 * something that *happens*. Who sits where and which character they wear is
 * table setup, fixed before a card is dealt (SPEC §9's seat-select screen).
 *
 * Typed as the three fields actually read rather than as `Seat`, so a `Seat`
 * still passes structurally — `openTable(state.seats)` works — while the type
 * states that hands and bets are not taken from it.
 */
export type SeatSetup = Pick<Seat, 'index' | 'occupant' | 'bankroll'>;

const EMPTY_DEALER: ShownDealer = {
  cards: [],
  total: null,
  soft: false,
  holeCardRevealed: false,
  busted: false,
};

/**
 * An empty felt, seated.
 *
 * Precondition: the seats are at a between-rounds rest state — no hands, no
 * bets. Every dynamic thing arrives as an event; the bankrolls are the opening
 * ones and are overwritten by the first `BetPlaced` or `BankrollChanged`.
 */
export function openTable(seats: readonly SeatSetup[]): ShownTable {
  return {
    phase: 'idle',
    roundNumber: 0,
    shoeIndex: 0,
    seats: seats.map(restSeat),
    dealer: EMPTY_DEALER,
    turnSeat: -1,
    legalActions: [],
    insuranceOffer: null,
    shufflePending: false,
  };
}

export function showEvents(table: ShownTable, events: readonly GameEvent[]): ShownTable {
  return events.reduce(showEvent, table);
}

/**
 * Fold one event onto the felt.
 *
 * Exhaustive over `GameEvent` by construction: the `default` branch takes an
 * `event` narrowed to `never`, so adding an event variant without deciding what
 * it draws is a compile error rather than a card that silently never appears.
 */
export function showEvent(table: ShownTable, event: GameEvent): ShownTable {
  switch (event.type) {
    case 'RoundStarted':
      // `shoeIndex` is taken from the event rather than trusted from the running
      // count, so a round always starts the tray at the truth. Between rounds the
      // count is maintained card by card, because no event reports it mid-round.
      return { ...table, roundNumber: event.roundNumber, shoeIndex: event.shoeIndex };

    case 'BetPlaced':
      return withSeat(table, event.seat, (seat) => ({
        ...seat,
        bankroll: event.bankroll,
        baseBet: event.amount,
        hands: [emptyHand(event.amount, false)],
      }));

    case 'CardDealt': {
      const drawn = { ...table, shoeIndex: table.shoeIndex + 1 };
      if (event.seat === 'dealer') {
        return {
          ...drawn,
          dealer: {
            ...drawn.dealer,
            cards: [...drawn.dealer.cards, { facing: 'up', card: event.card }],
            total: event.total,
            soft: event.soft,
          },
        };
      }
      return withHand(drawn, event.seat, event.handIndex, (hand) => ({
        ...hand,
        cards: [...hand.cards, event.card],
        total: event.total,
        soft: event.soft,
      }));
    }

    case 'HoleCardPlaced':
      // A card leaves the shoe and lands face down. Its identity is not in this
      // event, and that is the point — the UI must be able to draw the table
      // without it, which is exactly what `facing: 'down'` forces.
      return {
        ...table,
        shoeIndex: table.shoeIndex + 1,
        dealer: { ...table.dealer, cards: [...table.dealer.cards, { facing: 'down' }] },
      };

    case 'InsuranceOffered':
      return { ...table, insuranceOffer: event.seats };

    case 'InsuranceTaken':
      return withSeat(table, event.seat, (seat) => ({
        ...seat,
        bankroll: event.bankroll,
        insuranceBet: event.amount,
        insuranceResolved: true,
      }));

    case 'InsuranceDeclined':
      return withSeat(table, event.seat, (seat) => ({ ...seat, insuranceResolved: true }));

    case 'HoleCardRevealed':
      return {
        ...table,
        dealer: {
          ...table.dealer,
          cards: turnHoleCardUp(table.dealer.cards, event.card),
          total: event.total,
          soft: event.soft,
          holeCardRevealed: true,
        },
      };

    case 'PlayerActed':
      return withSeat(table, event.ref.seat, (seat) => ({
        ...seat,
        lastAction: event.action,
        lastActionWasRecommended: event.wasRecommended ?? null,
      }));

    case 'HandBusted':
      // `HandBusted` and `DealerBusted` carry no `soft`, and correctly so: a
      // busted hand cannot be soft. `handTotal` demotes aces while the total is
      // over 21, so a hand still above 21 has no ace left counting eleven. This
      // is the one place a hard-coded `false` here is a fact about the game
      // rather than a field the event forgot.
      return withHand(table, event.ref.seat, event.ref.handIndex, (hand) => ({
        ...hand,
        total: event.total,
        soft: false,
        busted: true,
      }));

    case 'HandStood':
      return withHand(table, event.ref.seat, event.ref.handIndex, (hand) => ({
        ...hand,
        total: event.total,
        soft: event.soft,
        standing: true,
      }));

    case 'HandDoubled':
      return withHand(
        { ...table, shoeIndex: table.shoeIndex + 1 },
        event.ref.seat,
        event.ref.handIndex,
        (hand) => ({
          ...hand,
          cards: [...hand.cards, event.card],
          bet: event.bet,
          total: event.total,
          soft: event.soft,
          doubled: true,
        }),
      );

    case 'HandSplit':
      return splitHand(table, event.ref.seat, event.ref.handIndex, event.newHandIndex, event.bet);

    case 'HandSurrendered':
      return withHand(table, event.ref.seat, event.ref.handIndex, (hand) => ({
        ...hand,
        surrendered: true,
      }));

    case 'TurnStarted':
      // Exactly one hand is acting at a time, so the cursor is set rather than
      // moved: whoever held it before does not need to be found and cleared.
      return {
        ...table,
        turnSeat: event.ref.seat,
        legalActions: event.legalActions,
        seats: table.seats.map((seat) =>
          seat.index === event.ref.seat
            ? { ...seat, activeHandIndex: event.ref.handIndex }
            : { ...seat, activeHandIndex: -1 },
        ),
      };

    case 'DealerDrew':
      return {
        ...table,
        shoeIndex: table.shoeIndex + 1,
        dealer: {
          ...table.dealer,
          cards: [...table.dealer.cards, { facing: 'up', card: event.card }],
          total: event.total,
          soft: event.soft,
        },
      };

    case 'DealerStood':
      return { ...table, dealer: { ...table.dealer, total: event.total, soft: event.soft } };

    case 'DealerBusted':
      return {
        ...table,
        dealer: { ...table.dealer, total: event.total, soft: false, busted: true },
      };

    case 'HandSettled':
      return withHand(table, event.ref.seat, event.ref.handIndex, (hand) => ({
        ...hand,
        outcome: event.outcome,
        net: event.net,
      }));

    case 'InsuranceSettled':
      // Nothing on the felt changes: the chips move on the `BankrollChanged`
      // that follows. Named rather than defaulted so the exhaustiveness check
      // stays meaningful.
      return table;

    case 'BankrollChanged':
      return withSeat(table, event.seat, (seat) => ({ ...seat, bankroll: event.bankroll }));

    case 'CutCardReached':
      return { ...table, shoeIndex: event.shoeIndex, shufflePending: true };

    case 'ShuffleStarted':
      return { ...table, shoeIndex: 0, shufflePending: false };

    case 'PhaseChanged':
      return changePhase(table, event.from, event.to);

    default: {
      const unhandled: never = event;
      throw new Error(`showEvent: unhandled event ${JSON.stringify(unhandled)}`);
    }
  }
}

// --- Phase ------------------------------------------------------------------

/**
 * The felt clears on the way *out* of `cleanup`, not on the way in, because that
 * is when the engine clears it — `cleanup()` builds the cleared state and the
 * transition out of the phase is what carries it. Clearing a phase early would
 * put the projection permanently one step ahead of the state it is checked
 * against, which is the bug this whole module exists to prevent.
 */
function changePhase(table: ShownTable, from: Phase, to: Phase): ShownTable {
  const cleared = from === 'cleanup' ? clearFelt(table) : table;
  // Only `playerTurn` has an acting seat. Clearing here rather than hunting for
  // the specific transitions keeps the cursor honest on every path out, including
  // a round where nobody ever acts.
  const idle =
    to === 'playerTurn'
      ? cleared
      : {
          ...cleared,
          turnSeat: -1,
          legalActions: [],
          seats: cleared.seats.map((seat) => ({ ...seat, activeHandIndex: -1 })),
        };
  return { ...idle, phase: to };
}

function clearFelt(table: ShownTable): ShownTable {
  return {
    ...table,
    seats: table.seats.map((seat) => ({
      ...restSeat(seat),
      // Survives the sweep: M5's characters react to the round that just ended,
      // and the reaction outlives the cards.
      lastAction: seat.lastAction,
      lastActionWasRecommended: seat.lastActionWasRecommended,
    })),
    dealer: EMPTY_DEALER,
    insuranceOffer: null,
  };
}

// --- Seats and hands --------------------------------------------------------

function restSeat(seat: SeatSetup): ShownSeat {
  return {
    index: seat.index,
    occupant: seat.occupant,
    bankroll: seat.bankroll,
    baseBet: 0,
    insuranceBet: 0,
    insuranceResolved: false,
    hands: [],
    activeHandIndex: -1,
    lastAction: null,
    lastActionWasRecommended: null,
  };
}

function emptyHand(bet: number, fromSplit: boolean): ShownHand {
  return {
    cards: [],
    bet,
    total: null,
    soft: false,
    fromSplit,
    doubled: false,
    standing: false,
    busted: false,
    surrendered: false,
    outcome: null,
    net: null,
  };
}

/**
 * A split leaves two one-card hands, and the new one is *inserted* after the
 * original rather than appended — every later hand of that seat shifts up by
 * one. `HandSplit.newHandIndex` carries the insertion point, so this follows the
 * event rather than reproducing the engine's rule.
 */
function splitHand(
  table: ShownTable,
  seatIndex: number,
  handIndex: number,
  newHandIndex: number,
  bet: number,
): ShownTable {
  return withSeat(table, seatIndex, (seat) => {
    const hand = handOf(seat, handIndex);
    const [first, second] = hand.cards;
    if (first === undefined || second === undefined) {
      throw new Error(`showEvent: seat ${seatIndex} split a hand holding ${hand.cards.length} cards`);
    }
    const hands = [...seat.hands];
    // Totals go back to null on both halves: a one-card hand has no total any
    // event has reported, and each half gets one when its second card lands.
    hands[handIndex] = { ...emptyHand(bet, true), cards: [first] };
    hands.splice(newHandIndex, 0, { ...emptyHand(bet, true), cards: [second] });
    return { ...seat, hands };
  });
}

function turnHoleCardUp(cards: readonly ShownCard[], card: Card): readonly ShownCard[] {
  const at = cards.findIndex((shown) => shown.facing === 'down');
  if (at < 0) throw new Error('showEvent: the hole card was revealed but none is face down');
  return cards.map((shown, i) => (i === at ? { facing: 'up' as const, card } : shown));
}

function withSeat(
  table: ShownTable,
  seatIndex: number,
  update: (seat: ShownSeat) => ShownSeat,
): ShownTable {
  let found = false;
  const seats = table.seats.map((seat) => {
    if (seat.index !== seatIndex) return seat;
    found = true;
    return update(seat);
  });
  if (!found) throw new Error(`showEvent: no seat ${seatIndex} at this table`);
  return { ...table, seats };
}

function withHand(
  table: ShownTable,
  seatIndex: number,
  handIndex: number,
  update: (hand: ShownHand) => ShownHand,
): ShownTable {
  return withSeat(table, seatIndex, (seat) => {
    handOf(seat, handIndex);
    return { ...seat, hands: seat.hands.map((hand, i) => (i === handIndex ? update(hand) : hand)) };
  });
}

/**
 * Throws rather than ignoring the event. An event naming a hand the felt does
 * not have means the fold has drifted from the stream, and a projection that
 * quietly skipped it would render a table missing one card — a defect visible
 * only to whoever happened to be looking at that seat.
 */
function handOf(seat: ShownSeat, handIndex: number): ShownHand {
  const hand = seat.hands[handIndex];
  if (hand === undefined) {
    throw new Error(`showEvent: seat ${seat.index} has no hand at index ${handIndex}`);
  }
  return hand;
}
