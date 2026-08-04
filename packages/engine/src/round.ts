/**
 * The round state machine (SPEC §4).
 *
 * Two rules govern this file:
 *
 * 1. Every transition is a pure function `state -> { state, events }`. Nothing
 *    here waits on an animation, and nothing in the UI can mutate state. The UI
 *    drains the event list on its own clock, arbitrarily far behind.
 * 2. The engine never invents a decision. When a seat has to choose, `advance`
 *    stops and `pendingDecision` reports what is needed. Bots (M3) and the human
 *    player go through exactly the same door, which is what keeps the
 *    counterfactual replay (SPEC §7) honest.
 *
 * Seat order is load-bearing, not cosmetic: it decides whether the player acts
 * before or after the jerk bot.
 */

import {
  cutCardReached,
  dealCard,
  createShoe,
  reshuffle,
  type Card,
  type Shoe,
} from './cards.js';
import type { GameEvent, SeatRef } from './events.js';
import {
  createHand,
  dealerShouldHit,
  handTotal,
  isBlackjack,
  isBust,
  isPairOfAces,
  isResolved,
  legalActions,
  type Action,
  type Hand,
  type LegalActionContext,
} from './hand.js';
import { deriveSeed } from './rng.js';
import type { RuleSet } from './rules.js';
import { settleRound } from './settle.js';
import {
  committed,
  handAt,
  isOccupied,
  seatAt,
  type DealerState,
  type Phase,
  type RoundState,
  type Seat,
  type SeatOccupant,
} from './state.js';

export type StepResult = {
  readonly state: RoundState;
  readonly events: readonly GameEvent[];
};

export type SeatConfig = {
  readonly occupant: SeatOccupant;
  readonly bankroll: number;
};

export type GameConfig = {
  readonly rules: RuleSet;
  readonly seed: number;
  /** One entry per seat, in table order. Length must equal `rules.seatCount`. */
  readonly seats: readonly SeatConfig[];
};

/**
 * What the engine is waiting for. `null` means it can advance on its own.
 * The caller must never guess — `advance` throws rather than fabricate a choice.
 */
export type PendingDecision =
  | { readonly kind: 'bets'; readonly seats: readonly number[] }
  | { readonly kind: 'insurance'; readonly seats: readonly number[]; readonly cost: number }
  | {
      readonly kind: 'action';
      readonly seat: number;
      readonly handIndex: number;
      readonly legalActions: readonly Action[];
    }
  | null;

// --- Construction ----------------------------------------------------------

export function createGame(config: GameConfig): RoundState {
  if (config.seats.length !== config.rules.seatCount) {
    throw new Error(
      `Expected ${config.rules.seatCount} seat configs, got ${config.seats.length}`,
    );
  }
  return {
    phase: 'idle',
    rules: config.rules,
    shoe: createShoe(deriveSeed(config.seed, 'shoe:0'), {
      deckCount: config.rules.deckCount,
      penetration: config.rules.penetration,
    }),
    seats: config.seats.map((seat, index) => emptyRoundSeat(index, seat)),
    dealer: { cards: [], holeCardRevealed: false, hasBlackjack: false },
    turnSeat: -1,
    roundNumber: 0,
    shoeSeed: config.seed,
    shufflePending: false,
  };
}

function emptyRoundSeat(index: number, config: SeatConfig): Seat {
  return {
    index,
    occupant: config.occupant,
    bankroll: config.bankroll,
    baseBet: 0,
    hands: [],
    activeHandIndex: -1,
    insuranceBet: 0,
    insuranceResolved: false,
  };
}

// --- Queries ---------------------------------------------------------------

export function pendingDecision(state: RoundState): PendingDecision {
  switch (state.phase) {
    case 'betting':
      return { kind: 'bets', seats: state.seats.filter(isOccupied).map((seat) => seat.index) };

    case 'insuranceOffer': {
      const seats = state.seats.filter((seat) => hasLiveBet(seat) && !seat.insuranceResolved);
      if (seats.length === 0) return null;
      return {
        kind: 'insurance',
        seats: seats.map((seat) => seat.index),
        cost: 0.5,
      };
    }

    case 'playerTurn': {
      if (state.turnSeat < 0) return null;
      const seat = seatAt(state, state.turnSeat);
      const handIndex = seat.activeHandIndex;
      if (handIndex < 0) return null;
      return {
        kind: 'action',
        seat: seat.index,
        handIndex,
        legalActions: legalActions(handAt(seat, handIndex), actionContext(state, seat)),
      };
    }

    default:
      return null;
  }
}

function actionContext(state: RoundState, seat: Seat): LegalActionContext {
  return {
    rules: state.rules,
    handCount: seat.hands.length,
    availableFunds: seat.bankroll,
  };
}

function hasLiveBet(seat: Seat): boolean {
  return isOccupied(seat) && seat.hands.length > 0;
}

/** Legal actions for a seat's active hand, or an empty list if it is not acting. */
export function legalActionsFor(state: RoundState, seatIndex: number): readonly Action[] {
  const decision = pendingDecision(state);
  if (decision?.kind !== 'action' || decision.seat !== seatIndex) return [];
  return decision.legalActions;
}

// --- Betting ---------------------------------------------------------------

/**
 * Place bets for every occupied seat and deal the round.
 * Seats absent from `bets` sit the round out.
 */
export function placeBets(state: RoundState, bets: ReadonlyMap<number, number>): StepResult {
  requirePhase(state, 'betting');
  const events: GameEvent[] = [];
  const seats = state.seats.map((seat) => {
    const amount = bets.get(seat.index);
    if (!isOccupied(seat) || amount === undefined || amount <= 0) return seat;
    validateBet(state.rules, amount, seat);
    events.push({
      type: 'BetPlaced',
      seat: seat.index,
      amount,
      bankroll: seat.bankroll - amount,
    });
    return {
      ...seat,
      bankroll: seat.bankroll - amount,
      baseBet: amount,
      hands: [createHand([], amount)],
      activeHandIndex: -1,
    };
  });

  if (seats.every((seat) => seat.hands.length === 0)) {
    throw new Error('At least one seat must bet to start a round');
  }

  return transition({ ...state, seats }, 'dealing', events);
}

function validateBet(rules: RuleSet, amount: number, seat: Seat): void {
  if (amount < rules.minBet) throw new Error(`Bet ${amount} is below the ${rules.minBet} minimum`);
  if (amount > rules.maxBet) throw new Error(`Bet ${amount} is above the ${rules.maxBet} maximum`);
  if (amount > seat.bankroll) {
    throw new Error(`Seat ${seat.index} cannot bet ${amount} with a bankroll of ${seat.bankroll}`);
  }
}

// --- Advancing -------------------------------------------------------------

/**
 * Perform the next automatic transition. Throws if a decision is outstanding —
 * silently doing nothing would turn a caller bug into a hang.
 */
export function advance(state: RoundState): StepResult {
  const decision = pendingDecision(state);
  if (decision !== null) {
    throw new Error(`Cannot advance: waiting for ${decision.kind}`);
  }

  switch (state.phase) {
    case 'idle':
      return startRound(state);
    case 'dealing':
      return dealInitialCards(state);
    case 'insuranceOffer':
      return transition(state, nextPhaseAfterInsurance(state), []);
    case 'dealerPeek':
      return peek(state);
    case 'playerTurn':
      return advanceTurn(state);
    case 'dealerPlay':
      return playDealer(state);
    case 'settlement':
      return settle(state);
    case 'cleanup':
      return cleanup(state);
    case 'shuffle':
      return doShuffle(state);
    case 'betting':
      throw new Error('Betting requires placeBets()');
  }
}

/**
 * Advance repeatedly until some seat has a decision to make.
 *
 * Note this can run a whole round to completion: a round in which nobody has a
 * choice — every hand a natural, or the dealer peeking to one — deals, settles,
 * cleans up and stops at the *next* betting phase, all in one call.
 */
export function advanceUntilDecision(state: RoundState): StepResult {
  const events: GameEvent[] = [];
  let current = state;
  let guard = 0;
  while (pendingDecision(current) === null) {
    if (++guard > 10_000) throw new Error('State machine failed to reach a decision point');
    const step = advance(current);
    current = step.state;
    events.push(...step.events);
  }
  return { state: current, events };
}

function startRound(state: RoundState): StepResult {
  const roundNumber = state.roundNumber + 1;
  return transition({ ...state, roundNumber }, 'betting', [
    { type: 'RoundStarted', roundNumber, shoeIndex: state.shoe.index },
  ]);
}

// --- Dealing ---------------------------------------------------------------

function dealInitialCards(state: RoundState): StepResult {
  const events: GameEvent[] = [];
  let shoe = state.shoe;
  const seats = state.seats.map((seat) => seat);
  const dealerCards: Card[] = [];

  // Two passes around the table, exactly as a dealer does it: the hole card is
  // the dealer's second card, so it is dealt last.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i] as Seat;
      if (!hasLiveBet(seat)) continue;
      const draw = dealCard(shoe);
      shoe = draw.shoe;
      const hand = handAt(seat, 0);
      const cards = [...hand.cards, draw.card];
      seats[i] = { ...seat, hands: [{ ...hand, cards }] };
      const { total, soft } = handTotal(cards);
      events.push({
        type: 'CardDealt',
        seat: seat.index,
        handIndex: 0,
        card: draw.card,
        total,
        soft,
        initialDeal: true,
      });
    }

    const draw = dealCard(shoe);
    shoe = draw.shoe;
    dealerCards.push(draw.card);
    if (pass === 0) {
      events.push({
        type: 'CardDealt',
        seat: 'dealer',
        handIndex: 0,
        card: draw.card,
        total: handTotal(dealerCards).total,
        soft: handTotal(dealerCards).soft,
        initialDeal: true,
      });
    } else {
      // The hole card goes face down: the UI must not learn its identity here.
      events.push({ type: 'HoleCardPlaced', dealerUpcard: dealerCards[0] as Card });
    }
  }

  const dealer: DealerState = {
    cards: dealerCards,
    holeCardRevealed: false,
    hasBlackjack: isBlackjack(dealerCards),
  };
  const dealt: RoundState = { ...state, shoe, seats, dealer };

  const upcard = dealerCards[0] as Card;
  if (dealt.rules.insuranceOffered && upcard.rank === 'A') {
    const seats = dealt.seats.filter(hasLiveBet).map((seat) => seat.index);
    return transition(dealt, 'insuranceOffer', [
      ...events,
      { type: 'InsuranceOffered', seats, cost: 0.5 },
    ]);
  }
  return transition(dealt, nextPhaseAfterInsurance(dealt), events);
}

function nextPhaseAfterInsurance(state: RoundState): Phase {
  const upcard = state.dealer.cards[0];
  if (upcard === undefined) throw new Error('No dealer upcard');
  const peekable = upcard.rank === 'A' || handTotal([upcard]).total === 10;
  if (state.rules.dealerPeeks && peekable) return 'dealerPeek';
  return 'playerTurn';
}

// --- Insurance -------------------------------------------------------------

/** Answer the insurance offer for one seat. Costs half the base bet, pays 2:1. */
export function takeInsurance(state: RoundState, seatIndex: number, take: boolean): StepResult {
  requirePhase(state, 'insuranceOffer');
  const seat = seatAt(state, seatIndex);
  if (seat.insuranceResolved) throw new Error(`Seat ${seatIndex} already answered insurance`);
  if (!hasLiveBet(seat)) throw new Error(`Seat ${seatIndex} has no bet this round`);

  const stake = seat.baseBet / 2;
  if (take && stake > seat.bankroll) {
    throw new Error(`Seat ${seatIndex} cannot afford ${stake} of insurance`);
  }

  const updated: Seat = take
    ? { ...seat, bankroll: seat.bankroll - stake, insuranceBet: stake, insuranceResolved: true }
    : { ...seat, insuranceResolved: true };

  const events: GameEvent[] = take
    ? [{ type: 'InsuranceTaken', seat: seatIndex, amount: stake, bankroll: updated.bankroll }]
    : [{ type: 'InsuranceDeclined', seat: seatIndex }];

  return { state: replaceSeat(state, updated), events };
}

// --- Peek ------------------------------------------------------------------

/**
 * The dealer checks the hole card on an ace or ten upcard. A natural ends the
 * round immediately — nobody gets to act, so this jumps straight to settlement.
 */
function peek(state: RoundState): StepResult {
  if (!state.dealer.hasBlackjack) {
    return transition(state, 'playerTurn', []);
  }
  const hole = state.dealer.cards[1];
  if (hole === undefined) throw new Error('No dealer hole card to peek at');
  const revealed: RoundState = {
    ...state,
    dealer: { ...state.dealer, holeCardRevealed: true },
  };
  return transition(revealed, 'settlement', [
    {
      type: 'HoleCardRevealed',
      card: hole,
      total: handTotal(state.dealer.cards).total,
      dealerBlackjack: true,
    },
  ]);
}

// --- Player turns ----------------------------------------------------------

/**
 * Move the cursor to the next hand that can act, dealing the outstanding card
 * to a freshly split hand on the way. Runs until a live decision is found or
 * every seat is done.
 *
 * The scan restarts at the *current* hand rather than the next one, because
 * most actions leave that same hand still live: a hit that did not bust acts
 * again, and a split leaves two hands where there was one. `isResolved` is what
 * moves the cursor on, not the act of having played.
 *
 * `justActed` names the hand `applyAction` has already emitted resolution
 * events for, so a bust is not reported twice.
 */
function advanceTurn(state: RoundState, justActed?: SeatRef): StepResult {
  const events: GameEvent[] = [];
  let current = state;
  let seatIndex = current.turnSeat < 0 ? 0 : current.turnSeat;
  let handIndex =
    current.turnSeat < 0
      ? 0
      : Math.max(0, seatAt(current, current.turnSeat).activeHandIndex);

  while (seatIndex < current.seats.length) {
    const seat = seatAt(current, seatIndex);
    if (!hasLiveBet(seat)) {
      seatIndex++;
      handIndex = 0;
      continue;
    }

    if (handIndex >= seat.hands.length) {
      current = replaceSeat(current, { ...seat, activeHandIndex: -1 });
      seatIndex++;
      handIndex = 0;
      continue;
    }

    // A hand created by a split is holding one card until its turn comes round.
    const topped = dealToSplitHand(current, seatIndex, handIndex);
    current = topped.state;
    events.push(...topped.events);

    const refreshed = seatAt(current, seatIndex);
    const hand = handAt(refreshed, handIndex);
    if (isResolved(hand)) {
      const alreadyReported =
        justActed !== undefined &&
        justActed.seat === seatIndex &&
        justActed.handIndex === handIndex;
      if (!alreadyReported) events.push(...resolutionEvents(seatIndex, handIndex, hand));
      handIndex++;
      continue;
    }

    current = {
      ...replaceSeat(current, { ...refreshed, activeHandIndex: handIndex }),
      turnSeat: seatIndex,
    };
    events.push({
      type: 'TurnStarted',
      ref: { seat: seatIndex, handIndex },
      legalActions: legalActions(hand, actionContext(current, seatAt(current, seatIndex))),
    });
    return { state: current, events };
  }

  return transition({ ...current, turnSeat: -1 }, 'dealerPlay', events);
}

/** A split hand receives its second card when its turn arrives, as at a table. */
function dealToSplitHand(state: RoundState, seatIndex: number, handIndex: number): StepResult {
  const seat = seatAt(state, seatIndex);
  const hand = handAt(seat, handIndex);
  if (hand.cards.length !== 1) return { state, events: [] };

  const draw = dealCard(state.shoe);
  const cards = [...hand.cards, draw.card];
  const { total, soft } = handTotal(cards);
  return {
    state: {
      ...replaceHand(state, seatIndex, handIndex, { ...hand, cards }),
      shoe: draw.shoe,
    },
    events: [
      {
        type: 'CardDealt',
        seat: seatIndex,
        handIndex,
        card: draw.card,
        total,
        soft,
        initialDeal: false,
      },
    ],
  };
}

/**
 * Apply a seat's chosen action. Rejects anything not in `legalActions`, which
 * is the single chokepoint enforcing the "no illegal action is ever accepted"
 * invariant (SPEC §8).
 */
export function applyAction(state: RoundState, seatIndex: number, action: Action): StepResult {
  requirePhase(state, 'playerTurn');
  if (state.turnSeat !== seatIndex) {
    throw new Error(`It is seat ${state.turnSeat}'s turn, not seat ${seatIndex}'s`);
  }
  const seat = seatAt(state, seatIndex);
  const handIndex = seat.activeHandIndex;
  const hand = handAt(seat, handIndex);
  const legal = legalActions(hand, actionContext(state, seat));
  if (!legal.includes(action)) {
    throw new Error(
      `Illegal action "${action}" for seat ${seatIndex} hand ${handIndex}; legal: ${legal.join(', ')}`,
    );
  }

  const ref = { seat: seatIndex, handIndex };
  const events: GameEvent[] = [{ type: 'PlayerActed', ref, action }];
  let next: RoundState;

  switch (action) {
    case 'stand':
      next = replaceHand(state, seatIndex, handIndex, { ...hand, stood: true });
      events.push({
        type: 'HandStood',
        ref,
        total: handTotal(hand.cards).total,
        soft: handTotal(hand.cards).soft,
      });
      break;

    case 'hit': {
      const draw = dealCard(state.shoe);
      const cards = [...hand.cards, draw.card];
      const { total, soft } = handTotal(cards);
      next = {
        ...replaceHand(state, seatIndex, handIndex, { ...hand, cards }),
        shoe: draw.shoe,
      };
      events.push({
        type: 'CardDealt',
        seat: seatIndex,
        handIndex,
        card: draw.card,
        total,
        soft,
        initialDeal: false,
      });
      if (isBust(cards)) events.push({ type: 'HandBusted', ref, total });
      break;
    }

    case 'double': {
      const draw = dealCard(state.shoe);
      const cards = [...hand.cards, draw.card];
      const { total } = handTotal(cards);
      const doubledSeat: Seat = { ...seat, bankroll: seat.bankroll - hand.bet };
      next = {
        ...replaceHand(replaceSeat(state, doubledSeat), seatIndex, handIndex, {
          ...hand,
          cards,
          bet: hand.bet * 2,
          doubled: true,
        }),
        shoe: draw.shoe,
      };
      events.push(
        { type: 'HandDoubled', ref, card: draw.card, total, bet: hand.bet * 2 },
        {
          type: 'BankrollChanged',
          seat: seatIndex,
          bankroll: doubledSeat.bankroll,
          delta: -hand.bet,
        },
      );
      if (isBust(cards)) events.push({ type: 'HandBusted', ref, total });
      break;
    }

    case 'split':
      next = applySplit(state, seatIndex, handIndex, hand, events);
      break;

    case 'surrender':
      next = replaceHand(state, seatIndex, handIndex, { ...hand, surrendered: true });
      events.push({ type: 'HandSurrendered', ref });
      break;
  }

  // The hand may now be finished; advanceTurn moves the cursor on and tops up
  // any split hand. It is safe to call when the same hand is still live.
  // A split is the one action that leaves its own hand still live, so it must
  // not suppress that hand's resolution event — a split ace tops up to two
  // cards and stands immediately, and the UI needs to hear about it.
  const continued = advanceTurn(next, action === 'split' ? undefined : ref);
  return { state: continued.state, events: [...events, ...continued.events] };
}

function applySplit(
  state: RoundState,
  seatIndex: number,
  handIndex: number,
  hand: Hand,
  events: GameEvent[],
): RoundState {
  const [first, second] = hand.cards;
  if (first === undefined || second === undefined) {
    throw new Error('Split requires exactly two cards');
  }
  const splittingAces = isPairOfAces(hand.cards);
  const seat = seatAt(state, seatIndex);

  const base = {
    bet: hand.bet,
    fromSplit: true,
    fromSplitAces: splittingAces && state.rules.oneCardToSplitAces,
    doubled: false,
    stood: false,
    surrendered: false,
  };
  const hands = [...seat.hands];
  hands[handIndex] = { ...base, cards: [first] };
  hands.splice(handIndex + 1, 0, { ...base, cards: [second] });

  events.push({
    type: 'HandSplit',
    ref: { seat: seatIndex, handIndex },
    newHandIndex: handIndex + 1,
    bet: hand.bet,
  });
  events.push({
    type: 'BankrollChanged',
    seat: seatIndex,
    bankroll: seat.bankroll - hand.bet,
    delta: -hand.bet,
  });

  // The split hand is topped up by advanceTurn, keeping one deal path.
  return replaceSeat(state, { ...seat, bankroll: seat.bankroll - hand.bet, hands });
}

function resolutionEvents(seat: number, handIndex: number, hand: Hand): GameEvent[] {
  const ref = { seat, handIndex };
  const { total, soft } = handTotal(hand.cards);
  if (isBust(hand.cards)) return [{ type: 'HandBusted', ref, total }];
  if (hand.stood || hand.doubled) return [];
  return [{ type: 'HandStood', ref, total, soft }];
}

// --- Dealer play -----------------------------------------------------------

/**
 * Reveal and draw to 17+. Skipped entirely when no hand can still be beaten:
 * if every player hand busted or surrendered the dealer does not draw, which
 * matters because those cards would otherwise change what the next round sees.
 */
function playDealer(state: RoundState): StepResult {
  const events: GameEvent[] = [];
  const hole = state.dealer.cards[1];
  if (hole === undefined) throw new Error('No dealer hole card');

  if (!state.dealer.holeCardRevealed) {
    events.push({
      type: 'HoleCardRevealed',
      card: hole,
      total: handTotal(state.dealer.cards).total,
      dealerBlackjack: state.dealer.hasBlackjack,
    });
  }

  let cards = [...state.dealer.cards];
  let shoe: Shoe = state.shoe;

  if (anyHandLive(state)) {
    while (dealerShouldHit(cards, state.rules)) {
      const draw = dealCard(shoe);
      shoe = draw.shoe;
      cards = [...cards, draw.card];
      const { total, soft } = handTotal(cards);
      events.push({ type: 'DealerDrew', card: draw.card, total, soft });
    }
    const { total, soft } = handTotal(cards);
    events.push(
      total > 21 ? { type: 'DealerBusted', total } : { type: 'DealerStood', total, soft },
    );
  }

  return transition(
    { ...state, shoe, dealer: { ...state.dealer, cards, holeCardRevealed: true } },
    'settlement',
    events,
  );
}

/** True if any hand can still be paid — i.e. the dealer's draw actually matters. */
function anyHandLive(state: RoundState): boolean {
  return state.seats.some(
    (seat) =>
      hasLiveBet(seat) &&
      seat.hands.some((hand) => !isBust(hand.cards) && !hand.surrendered),
  );
}

// --- Settlement ------------------------------------------------------------

function settle(state: RoundState): StepResult {
  const { hands, insurance } = settleRound(state);
  const events: GameEvent[] = [];
  const credits = new Map<number, number>();

  for (const entry of insurance) {
    events.push({
      type: 'InsuranceSettled',
      seat: entry.seat,
      bet: entry.bet,
      payout: entry.payout,
      net: entry.net,
    });
    credits.set(entry.seat, (credits.get(entry.seat) ?? 0) + entry.payout);
  }

  for (const entry of hands) {
    events.push({
      type: 'HandSettled',
      ref: { seat: entry.seat, handIndex: entry.handIndex },
      outcome: entry.outcome,
      bet: entry.bet,
      payout: entry.payout,
      net: entry.net,
    });
    credits.set(entry.seat, (credits.get(entry.seat) ?? 0) + entry.payout);
  }

  const seats = state.seats.map((seat) => {
    const credit = credits.get(seat.index);
    if (credit === undefined) return seat;
    const bankroll = seat.bankroll + credit;
    events.push({ type: 'BankrollChanged', seat: seat.index, bankroll, delta: credit });
    return { ...seat, bankroll };
  });

  return transition({ ...state, seats }, 'cleanup', events);
}

// --- Cleanup and shuffle ---------------------------------------------------

function cleanup(state: RoundState): StepResult {
  const events: GameEvent[] = [];
  const shufflePending = cutCardReached(state.shoe);
  if (shufflePending && !state.shufflePending) {
    events.push({ type: 'CutCardReached', shoeIndex: state.shoe.index });
  }

  const cleared: RoundState = {
    ...state,
    seats: state.seats.map((seat) => ({
      ...seat,
      baseBet: 0,
      hands: [],
      activeHandIndex: -1,
      insuranceBet: 0,
      insuranceResolved: false,
    })),
    dealer: { cards: [], holeCardRevealed: false, hasBlackjack: false },
    turnSeat: -1,
    shufflePending,
  };

  return transition(cleared, shufflePending ? 'shuffle' : 'betting', events);
}

/**
 * Reshuffle between rounds. The next seed is chained off the current one rather
 * than off `roundNumber`, so `roundNumber` stays a true count of hands played —
 * the report card (SPEC §9) reads it directly. Chaining still yields a distinct
 * seed per shuffle because `shoeSeed` changes every time.
 */
function doShuffle(state: RoundState): StepResult {
  const seed = deriveSeed(state.shoeSeed, 'reshuffle');
  return transition(
    {
      ...state,
      shoe: reshuffle(state.shoe, seed),
      shoeSeed: seed,
      shufflePending: false,
    },
    'betting',
    [{ type: 'ShuffleStarted', seed }],
  );
}

// --- Helpers ---------------------------------------------------------------

function transition(state: RoundState, to: Phase, events: readonly GameEvent[]): StepResult {
  if (state.phase === to) return { state, events };
  return {
    state: { ...state, phase: to },
    events: [...events, { type: 'PhaseChanged', from: state.phase, to }],
  };
}

function requirePhase(state: RoundState, phase: Phase): void {
  if (state.phase !== phase) {
    throw new Error(`Expected phase "${phase}" but the round is in "${state.phase}"`);
  }
}

function replaceSeat(state: RoundState, seat: Seat): RoundState {
  const seats = state.seats.map((existing) => (existing.index === seat.index ? seat : existing));
  return { ...state, seats };
}

function replaceHand(
  state: RoundState,
  seatIndex: number,
  handIndex: number,
  hand: Hand,
): RoundState {
  const seat = seatAt(state, seatIndex);
  const hands = seat.hands.map((existing, i) => (i === handIndex ? hand : existing));
  return replaceSeat(state, { ...seat, hands });
}

/** Total a seat has at risk this round — used by the UI and by bankroll checks. */
export function seatExposure(seat: Seat): number {
  return committed(seat);
}
