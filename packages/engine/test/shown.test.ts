import { describe, expect, it } from 'vitest';

import {
  advanceUntilPlayer,
  createGame,
  createSession,
  flatBettor,
  handTotal,
  isBust,
  JERK_POLICIES,
  mulberry32,
  openTable,
  PERFECT_POLICY,
  showEvent,
  showEvents,
  submitAction,
  submitBet,
  submitInsurance,
  VEGAS_STRIP,
  type Action,
  type BotPolicy,
  type Card,
  type Deciders,
  type GameEvent,
  type PlayerPrompt,
  type RoundState,
  type SeatConfig,
  type SeatDecider,
  type SeatOccupant,
  type SeatSetup,
  type ShownTable,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

const BANKROLL = 10_000_000;
const BET = 500;

type SeatSpec = 'player' | 'empty' | BotPolicy;

function game(seed: number, specs: readonly SeatSpec[]): RoundState {
  const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => {
    const spec = specs[i] ?? 'empty';
    if (spec === 'empty') return { occupant: { kind: 'empty' } as const, bankroll: 0 };
    if (spec === 'player') return { occupant: { kind: 'player' } as const, bankroll: BANKROLL };
    return {
      occupant: { kind: 'bot', policyId: spec.id, characterId: `c${i}` } as const,
      bankroll: BANKROLL,
    };
  });
  return createGame({ rules: VEGAS_STRIP, seed, seats });
}

function botDeciders(specs: readonly SeatSpec[]): Deciders {
  const entries: [number, SeatDecider][] = [];
  specs.forEach((spec, index) => {
    if (spec === 'player' || spec === 'empty') return;
    entries.push([index, flatBettor(spec, BET)]);
  });
  return new Map(entries);
}

/**
 * A player who takes every split on offer, doubles half the time and otherwise
 * picks at random.
 *
 * Deliberately not basic strategy. The projection has to reproduce a bad line
 * as exactly as a good one — the engine has no opinion about correctness (M1
 * decision 7) — and book play barely ever resplits, surrenders a natural to a
 * double, or busts a doubled hand. `assertCoverage` checks the resulting drive
 * really did contain those, so this test cannot quietly stop proving anything.
 */
function wildPlayer(seed: number): SeatDecider {
  const rng = mulberry32(seed);
  return {
    bet: () => BET,
    takeInsurance: () => rng.next() < 0.5,
    act: (view) => {
      const legal = view.legalActions;
      if (legal.includes('split')) return 'split';
      if (legal.includes('double') && rng.next() < 0.5) return 'double';
      return legal[rng.nextInt(legal.length)] as Action;
    },
  };
}

// --- The snapshot both sides are reduced to --------------------------------

/**
 * The face-down card is compared as a marker rather than a card, because that
 * is the one thing the projection is *supposed* not to know. Everything else is
 * compared as itself.
 */
type ShownCardSnapshot = Card | 'facedown';

type HandSnapshot = {
  cards: readonly Card[];
  bet: number;
  total: number | null;
  soft: boolean;
  fromSplit: boolean;
  doubled: boolean;
  busted: boolean;
  surrendered: boolean;
};

type SeatSnapshot = {
  index: number;
  occupant: SeatOccupant;
  bankroll: number;
  baseBet: number;
  insuranceBet: number;
  insuranceResolved: boolean;
  activeHandIndex: number;
  hands: readonly HandSnapshot[];
};

type TableSnapshot = {
  phase: string;
  roundNumber: number;
  shoeIndex: number;
  turnSeat: number;
  dealerCards: readonly ShownCardSnapshot[];
  dealerTotal: number | null;
  dealerSoft: boolean;
  holeCardRevealed: boolean;
  seats: readonly SeatSnapshot[];
};

function snapshotShown(table: ShownTable): TableSnapshot {
  return {
    phase: table.phase,
    roundNumber: table.roundNumber,
    shoeIndex: table.shoeIndex,
    turnSeat: table.turnSeat,
    dealerCards: table.dealer.cards.map((shown) =>
      shown.facing === 'up' ? shown.card : 'facedown',
    ),
    dealerTotal: table.dealer.total,
    dealerSoft: table.dealer.soft,
    holeCardRevealed: table.dealer.holeCardRevealed,
    seats: table.seats.map((seat) => ({
      index: seat.index,
      occupant: seat.occupant,
      bankroll: seat.bankroll,
      baseBet: seat.baseBet,
      insuranceBet: seat.insuranceBet,
      insuranceResolved: seat.insuranceResolved,
      activeHandIndex: seat.activeHandIndex,
      hands: seat.hands.map((hand) => ({
        cards: hand.cards,
        bet: hand.bet,
        total: hand.total,
        soft: hand.soft,
        fromSplit: hand.fromSplit,
        doubled: hand.doubled,
        busted: hand.busted,
        surrendered: hand.surrendered,
      })),
    })),
  };
}

/**
 * The same snapshot taken from the engine's own state — the answer the fold has
 * to arrive at independently.
 *
 * One field needs a rule rather than a copy, and it is stated here rather than
 * being quietly matched to whatever the projection happens to do: **`total` is
 * null below two cards.** No event has carried a total for a hand holding one
 * card, which happens between a split and the second card the engine deals
 * lazily (M1 decision 4). The projection is forbidden from computing one, so
 * `null` is the only honest value and this asserts it.
 *
 * `standing` is deliberately *not* compared here. It is not `hand.stood` — the
 * engine emits `HandStood` for any hand that finishes un-busted and un-doubled,
 * including a natural, neither of which sets `stood` — and it is not
 * `isResolved` either, because the engine announces a resolution when the turn
 * cursor reaches the hand, not the instant it becomes true. A hand can sit
 * resolved and unannounced at a seat the dealer has not got to yet, exactly as
 * at a real table. What actually has to hold is an ordering, not an equality,
 * so it is asserted as one by `assertAnnouncedBeforePaid`.
 */
function snapshotState(state: RoundState): TableSnapshot {
  const dealer = state.dealer;
  const upcard = dealer.cards[0];
  const facing = dealer.holeCardRevealed ? dealer.cards : upcard === undefined ? [] : [upcard];
  const dealerTotal = facing.length === 0 ? null : handTotal(facing).total;

  return {
    phase: state.phase,
    roundNumber: state.roundNumber,
    shoeIndex: state.shoe.index,
    turnSeat: state.turnSeat,
    dealerCards: dealer.cards.map((card, i) =>
      !dealer.holeCardRevealed && i === 1 ? 'facedown' : card,
    ),
    dealerTotal,
    dealerSoft: facing.length === 0 ? false : handTotal(facing).soft,
    holeCardRevealed: dealer.holeCardRevealed,
    seats: state.seats.map((seat) => ({
      index: seat.index,
      occupant: seat.occupant,
      bankroll: seat.bankroll,
      baseBet: seat.baseBet,
      insuranceBet: seat.insuranceBet,
      insuranceResolved: seat.insuranceResolved,
      activeHandIndex: seat.activeHandIndex,
      hands: seat.hands.map((hand) => {
        const { total, soft } = handTotal(hand.cards);
        const busted = isBust(hand.cards);
        const known = hand.cards.length >= 2;
        return {
          cards: hand.cards,
          bet: hand.bet,
          total: known ? total : null,
          soft: known ? soft : false,
          fromSplit: hand.fromSplit,
          doubled: hand.doubled,
          busted,
          surrendered: hand.surrendered,
        };
      }),
    })),
  };
}

// --- Driving a session while folding its events ----------------------------

type Checkpoint = {
  readonly table: ShownTable;
  readonly state: RoundState;
  readonly prompt: PlayerPrompt;
};

type Drive = {
  readonly checkpoints: readonly Checkpoint[];
  readonly events: readonly GameEvent[];
  /** How many hands were paid — so the ordering check below cannot be vacuous. */
  readonly paid: number;
};

/**
 * If anyone was given the chance to act this round, no hand is paid without
 * having first been announced as finished.
 *
 * This is the property `standing` actually carries. It is an ordering between
 * two events rather than an equality against state, so it is checked where
 * orderings are visible: mid-fold, at the instant `HandSettled` arrives.
 *
 * It is the assertion that catches a resolution the engine never announced. A
 * hand that hit to exactly 21 used to arrive here with every flag false — the
 * screen had been told a card was dealt and never told the hand was over, so it
 * would have stayed drawn as live until the felt cleared.
 *
 * The `playerTurn` guard is a real exception rather than a concession. When the
 * dealer peeks to a natural the round goes straight from the peek to settlement:
 * nobody acts, no hand *finished* in any sense the table would announce, and
 * `HoleCardRevealed` with `dealerBlackjack` is itself the announcement, for
 * everyone at once. Demanding a per-hand one there would be demanding an event
 * that should not exist.
 */
function assertAnnouncedBeforePaid(
  table: ShownTable,
  event: GameEvent,
  anyoneActed: boolean,
): void {
  if (event.type !== 'HandSettled' || !anyoneActed) return;
  const seat = table.seats.find((candidate) => candidate.index === event.ref.seat);
  const hand = seat?.hands[event.ref.handIndex];
  if (hand === undefined) throw new Error('settled a hand the felt does not have');
  expect(
    hand.standing || hand.busted || hand.doubled || hand.surrendered,
    `seat ${event.ref.seat} hand ${event.ref.handIndex} was paid without being announced finished`,
  ).toBe(true);
}

/**
 * Play `rounds` rounds, folding every event onto the felt as it is emitted, and
 * keep the felt and the engine's state side by side at every prompt.
 *
 * A prompt is the right checkpoint because it is the only moment the two are
 * required to agree: between calls the state runs ahead of the events by
 * construction (M4 decision 34), but a call *ends* at a prompt with every event
 * it produced already returned.
 */
function drive(start: RoundState, player: SeatDecider, bots: Deciders, rounds: number): Drive {
  let table = openTable(start.seats);
  const events: GameEvent[] = [];
  let paid = 0;
  let anyoneActed = false;

  // Folded one at a time rather than a list at a time, because the ordering
  // check needs the felt as it stood *at* each event, not after the batch.
  const show = (emitted: readonly GameEvent[]): void => {
    for (const event of emitted) {
      if (event.type === 'RoundStarted') anyoneActed = false;
      if (event.type === 'PhaseChanged' && event.to === 'playerTurn') anyoneActed = true;
      assertAnnouncedBeforePaid(table, event, anyoneActed);
      if (event.type === 'HandSettled' && anyoneActed) paid++;
      table = showEvent(table, event);
      events.push(event);
      COVERED.add(event.type);
    }
  };

  let step = advanceUntilPlayer(createSession(start), bots);
  show(step.events);
  const checkpoints: Checkpoint[] = [{ table, state: step.session.state, prompt: step.prompt }];

  let guard = 0;
  for (;;) {
    if (++guard > 100_000) throw new Error('drive: session never finished');
    const prompt = step.prompt;
    if (prompt.kind === 'bet') {
      if (step.session.state.roundNumber > rounds) break;
      step = submitBet(step.session, player.bet(prompt.view), bots);
    } else if (prompt.kind === 'insurance') {
      step = submitInsurance(step.session, player.takeInsurance(prompt.view), bots);
    } else {
      step = submitAction(step.session, player.act(prompt.view), bots);
    }
    show(step.events);
    checkpoints.push({ table, state: step.session.state, prompt: step.prompt });
  }

  return { checkpoints, events, paid };
}

/**
 * Event types seen across every drive in this file.
 *
 * Accumulated across the suite rather than asserted per drive, because the
 * layouts are not interchangeable: forty rounds heads-up consume nowhere near
 * enough of a six-deck shoe to reach the cut card, and a table with one seat
 * meets an ace upcard far less often. Demanding every type from every layout
 * would have made the coverage guard a statement about seat counts.
 */
const COVERED = new Set<GameEvent['type']>();

// --- The equivalence -------------------------------------------------------

describe('the felt reconstructed from events equals the engine state', () => {
  const layouts: readonly (readonly SeatSpec[])[] = [
    ['player'],
    ['player', PERFECT_POLICY, PERFECT_POLICY],
    [PERFECT_POLICY, PERFECT_POLICY, 'player'],
    [
      JERK_POLICIES[0] as BotPolicy,
      JERK_POLICIES[1] as BotPolicy,
      'player',
      JERK_POLICIES[2] as BotPolicy,
      JERK_POLICIES[3] as BotPolicy,
      JERK_POLICIES[4] as BotPolicy,
      JERK_POLICIES[5] as BotPolicy,
    ],
  ];

  for (const [layoutIndex, specs] of layouts.entries()) {
    for (const seed of [11, 2027, 99_991]) {
      it(`layout ${layoutIndex} seed ${seed}`, () => {
        const { checkpoints, paid } = drive(
          game(seed, specs),
          wildPlayer(seed),
          botDeciders(specs),
          40,
        );

        expect(checkpoints.length).toBeGreaterThan(40);
        // Only that the announcement check above had plenty to chew on. Not a
        // count of anything — a heads-up drive pays close to one hand a round,
        // a full table pays seven.
        expect(paid).toBeGreaterThan(20);
        for (const [i, point] of checkpoints.entries()) {
          expect(snapshotShown(point.table), `checkpoint ${i} (${point.prompt.kind})`).toEqual(
            snapshotState(point.state),
          );
        }
      });
    }
  }

  /**
   * Runs last, and asserts the drives above were worth running. A suite that
   * never split, doubled, busted, insured or reached a shuffle would still pass
   * every equality above while proving almost nothing — M3 decision 21's shape
   * of invisibility, pointed at this file's own coverage.
   */
  it('exercised every event the felt has to draw', () => {
    for (const type of [
      'RoundStarted',
      'BetPlaced',
      'CardDealt',
      'HoleCardPlaced',
      'InsuranceOffered',
      'InsuranceTaken',
      'InsuranceDeclined',
      'HoleCardRevealed',
      'PlayerActed',
      'HandBusted',
      'HandStood',
      'HandDoubled',
      'HandSplit',
      'TurnStarted',
      'DealerDrew',
      'DealerStood',
      'DealerBusted',
      'HandSettled',
      'InsuranceSettled',
      'BankrollChanged',
      'CutCardReached',
      'ShuffleStarted',
      'PhaseChanged',
    ] as const) {
      expect(COVERED, `no drive ever emitted ${type}`).toContain(type);
    }
  });

  it('offers the buttons the prompt offers', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY];
    const { checkpoints } = drive(game(5, specs), wildPlayer(5), botDeciders(specs), 30);

    let actions = 0;
    let insurances = 0;
    for (const { table, prompt } of checkpoints) {
      if (prompt.kind === 'action') {
        actions++;
        // The action buttons are drawn from the felt, not from the session, so
        // `TurnStarted.legalActions` has to be sufficient on its own.
        expect(table.legalActions).toEqual(prompt.view.legalActions);
        expect(table.turnSeat).toBe(prompt.view.seat.index);
      }
      if (prompt.kind === 'insurance') {
        insurances++;
        expect(table.insuranceOffer).toContain(prompt.view.seat.index);
      }
      if (prompt.kind === 'bet') {
        expect(table.legalActions).toEqual([]);
        expect(table.turnSeat).toBe(-1);
      }
    }
    expect(actions).toBeGreaterThan(20);
    expect(insurances).toBeGreaterThan(0);
  });
});

// --- The hole card ---------------------------------------------------------

/** Every object and value reachable from `root`, by identity. */
function reachable(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    stack.push(...Object.values(value as Record<string, unknown>));
  }
  return seen;
}

describe('the hole card', () => {
  /**
   * The mirror of `view.ts`'s censorship test (M3 decision 22), from the other
   * direction. `view.ts` keeps a face-down card away from a *bot*; this keeps it
   * away from the *screen*. Both compare card instances rather than ranks,
   * because the hole card's rank is legitimately face up elsewhere on the table
   * all the time.
   */
  it('is never reachable from the felt while it is face down', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY, PERFECT_POLICY];
    const { checkpoints } = drive(game(31, specs), wildPlayer(31), botDeciders(specs), 40);

    let facedown = 0;
    for (const { table, state } of checkpoints) {
      const hole = state.dealer.cards[1];
      if (hole === undefined || state.dealer.holeCardRevealed) continue;
      facedown++;
      expect(reachable(table).has(hole)).toBe(false);
      expect(table.dealer.cards.some((shown) => shown.facing === 'down')).toBe(true);
    }
    expect(facedown).toBeGreaterThan(20);
  });

  it('is drawn as a card that is there, not as a card that is missing', () => {
    const specs: SeatSpec[] = ['player'];
    const { checkpoints } = drive(game(4, specs), wildPlayer(4), botDeciders(specs), 10);
    const acting = checkpoints.find((point) => point.prompt.kind === 'action');
    if (acting === undefined) throw new Error('no action prompt');

    expect(acting.table.dealer.cards).toHaveLength(2);
    expect(acting.table.dealer.cards[1]).toEqual({ facing: 'down' });
    expect(acting.table.dealer.total).toBe(
      handTotal([acting.state.dealer.cards[0] as Card]).total,
    );
  });
});

// --- The fold itself -------------------------------------------------------

const SEATS: readonly SeatSetup[] = [
  { index: 0, occupant: { kind: 'player' }, bankroll: 10_000 },
  { index: 1, occupant: { kind: 'bot', policyId: 'perfect', characterId: 'c1' }, bankroll: 10_000 },
];

let cardSerial = 0;
/** Distinct `id` per card, so the fold's identity handling is not flattered. */
const card = (rank: Card['rank']): Card => ({ rank, suit: 'S', id: `${rank}S#${cardSerial++}` });

describe('openTable', () => {
  it('seats the table and draws nothing else', () => {
    const table = openTable(SEATS);
    expect(table.phase).toBe('idle');
    expect(table.roundNumber).toBe(0);
    expect(table.shoeIndex).toBe(0);
    expect(table.turnSeat).toBe(-1);
    expect(table.dealer.cards).toEqual([]);
    expect(table.seats.map((seat) => seat.occupant.kind)).toEqual(['player', 'bot']);
    expect(table.seats.every((seat) => seat.hands.length === 0)).toBe(true);
  });
});

describe('showEvents', () => {
  it('does not mutate the table it is given', () => {
    const before = openTable(SEATS);
    const frozen = JSON.parse(JSON.stringify(before)) as unknown;
    showEvents(before, [
      { type: 'RoundStarted', roundNumber: 1, shoeIndex: 0 },
      { type: 'BetPlaced', seat: 0, amount: 500, bankroll: 9500 },
    ]);
    expect(before).toEqual(frozen);
  });

  it('inserts a split hand after the one it came from, shifting the rest up', () => {
    const table = showEvents(openTable(SEATS), [
      { type: 'BetPlaced', seat: 0, amount: 500, bankroll: 9500 },
      dealt(0, 0, card('8'), 8, false),
      dealt(0, 0, card('8'), 16, false),
      { type: 'HandSplit', ref: { seat: 0, handIndex: 0 }, newHandIndex: 1, bet: 500 },
      dealt(0, 0, card('3'), 11, false),
      { type: 'HandSplit', ref: { seat: 0, handIndex: 0 }, newHandIndex: 1, bet: 500 },
    ]);

    const hands = table.seats[0]?.hands ?? [];
    expect(hands.map((hand) => hand.cards.map((c) => c.rank))).toEqual([['8'], ['3'], ['8']]);
    expect(hands.every((hand) => hand.fromSplit && hand.bet === 500)).toBe(true);
    // A one-card hand has no total any event has reported, and the projection is
    // not allowed to work one out.
    expect(hands.map((hand) => hand.total)).toEqual([null, null, null]);
  });

  it('clears the felt on the way out of cleanup, keeping the last action', () => {
    const played = showEvents(openTable(SEATS), [
      { type: 'BetPlaced', seat: 0, amount: 500, bankroll: 9500 },
      dealt(0, 0, card('T'), 10, false),
      dealt(0, 0, card('9'), 19, false),
      { type: 'PlayerActed', ref: { seat: 0, handIndex: 0 }, action: 'stand' },
      { type: 'HandStood', ref: { seat: 0, handIndex: 0 }, total: 19, soft: false },
      { type: 'HandSettled', ref: { seat: 0, handIndex: 0 }, outcome: 'win', bet: 500, payout: 1000, net: 500 },
      { type: 'BankrollChanged', seat: 0, bankroll: 10_500, delta: 1000 },
      { type: 'PhaseChanged', from: 'settlement', to: 'cleanup' },
    ]);
    expect(played.seats[0]?.hands).toHaveLength(1);

    const swept = showEvent(played, { type: 'PhaseChanged', from: 'cleanup', to: 'idle' });
    expect(swept.seats[0]?.hands).toEqual([]);
    expect(swept.seats[0]?.baseBet).toBe(0);
    expect(swept.seats[0]?.bankroll).toBe(10_500);
    // The cards go; the reaction stays, because M5's characters respond to the
    // round that just ended.
    expect(swept.seats[0]?.lastAction).toBe('stand');
    expect(swept.dealer.cards).toEqual([]);
  });

  it('tracks the discard tray card by card, and empties it on a shuffle', () => {
    const table = showEvents(openTable(SEATS), [
      { type: 'RoundStarted', roundNumber: 9, shoeIndex: 200 },
      dealt('dealer', 0, card('6'), 6, false),
      { type: 'HoleCardPlaced', dealerUpcard: card('6') },
      { type: 'DealerDrew', card: card('5'), total: 11, soft: false },
    ]);
    expect(table.shoeIndex).toBe(203);

    const marked = showEvent(table, { type: 'CutCardReached', shoeIndex: 234 });
    expect(marked).toMatchObject({ shoeIndex: 234, shufflePending: true });
    expect(showEvent(marked, { type: 'ShuffleStarted', seed: 7 })).toMatchObject({
      shoeIndex: 0,
      shufflePending: false,
    });
  });

  it('refuses an event about a seat or a hand that is not on the felt', () => {
    const table = openTable(SEATS);
    expect(() => showEvent(table, { type: 'BetPlaced', seat: 5, amount: 500, bankroll: 9500 })).toThrow(
      /no seat 5/,
    );
    expect(() => showEvent(table, dealt(0, 0, card('T'), 10, false))).toThrow(/no hand at index 0/);
  });

  it('refuses to reveal a hole card that was never placed', () => {
    expect(() =>
      showEvent(openTable(SEATS), {
        type: 'HoleCardRevealed',
        card: card('K'),
        total: 20,
        soft: false,
        dealerBlackjack: false,
      }),
    ).toThrow(/none is face down/);
  });
});

function dealt(
  seat: number | 'dealer',
  handIndex: number,
  dealtCard: Card,
  total: number,
  soft: boolean,
): GameEvent {
  return { type: 'CardDealt', seat, handIndex, card: dealtCard, total, soft, initialDeal: true };
}
