/**
 * Settlement math (SPEC §8). Table-driven on purpose: the payout rules are a
 * small closed set of cases, and the readable failure of a named row is worth
 * more than a hand-written assertion per case.
 */

import { describe, expect, it } from 'vitest';

import type { Card, Rank } from '../src/cards.js';
import { createShoe } from '../src/cards.js';
import type { Hand } from '../src/hand.js';
import { VEGAS_STRIP, type RuleSet } from '../src/rules.js';
import { settleHand, settleInsurance, settleRound, type HandOutcome } from '../src/settle.js';
import type { RoundState, Seat, SeatOccupant } from '../src/state.js';

// --- Builders --------------------------------------------------------------

/** 'AT' -> ace, ten. Ranks are single characters, so a string is the terse spec. */
function cardsOf(spec: string): readonly Card[] {
  return [...spec].map((rank, i): Card => ({ rank: rank as Rank, suit: 'S', id: `${rank}${spec}${i}` }));
}

type HandSpec = {
  readonly cards: string;
  readonly bet: number;
  readonly fromSplit?: boolean;
  readonly fromSplitAces?: boolean;
  readonly doubled?: boolean;
  readonly surrendered?: boolean;
};

function makeHand(spec: HandSpec): Hand {
  return {
    cards: cardsOf(spec.cards),
    bet: spec.bet,
    fromSplit: spec.fromSplit ?? false,
    fromSplitAces: spec.fromSplitAces ?? false,
    doubled: spec.doubled ?? false,
    stood: true,
    surrendered: spec.surrendered ?? false,
  };
}

type SeatSpec = {
  readonly index: number;
  readonly hands: readonly HandSpec[];
  readonly occupant?: SeatOccupant;
  readonly baseBet?: number;
  readonly insuranceBet?: number;
};

function makeSeat(spec: SeatSpec): Seat {
  return {
    index: spec.index,
    occupant: spec.occupant ?? { kind: 'player' },
    bankroll: 1000,
    baseBet: spec.baseBet ?? spec.hands[0]?.bet ?? 0,
    hands: spec.hands.map(makeHand),
    activeHandIndex: -1,
    insuranceBet: spec.insuranceBet ?? 0,
    insuranceResolved: true,
  };
}

function makeState(
  seats: readonly Seat[],
  dealerCards: string,
  dealerHasBlackjack = false,
  rules: RuleSet = VEGAS_STRIP,
): RoundState {
  return {
    phase: 'settlement',
    rules,
    shoe: createShoe(1, { deckCount: rules.deckCount, penetration: rules.penetration }),
    seats,
    dealer: { cards: cardsOf(dealerCards), holeCardRevealed: true, hasBlackjack: dealerHasBlackjack },
    turnSeat: -1,
    roundNumber: 1,
    shoeSeed: 1,
    shufflePending: false,
  };
}

// --- Hand settlement table -------------------------------------------------

type SettlementCase = {
  readonly name: string;
  readonly hand: HandSpec;
  readonly dealer: string;
  readonly dealerBlackjack?: boolean;
  readonly rules?: RuleSet;
  readonly outcome: HandOutcome;
  readonly payout: number;
  readonly net: number;
};

const CASES: readonly SettlementCase[] = [
  // Naturals.
  {
    name: 'natural beats a dealer 20 and pays 3:2',
    hand: { cards: 'AT', bet: 10 },
    dealer: 'TQ',
    outcome: 'blackjack',
    payout: 25,
    net: 15,
  },
  {
    name: 'natural on the $5 table minimum pays $7.50 profit, unrounded',
    hand: { cards: 'AK', bet: 5 },
    dealer: 'T9',
    outcome: 'blackjack',
    payout: 12.5,
    net: 7.5,
  },
  {
    name: 'natural against a dealer natural pushes',
    hand: { cards: 'AT', bet: 10 },
    dealer: 'AT',
    dealerBlackjack: true,
    outcome: 'push',
    payout: 10,
    net: 0,
  },
  {
    name: 'dealer natural beats a player 20',
    hand: { cards: 'TQ', bet: 10 },
    dealer: 'AJ',
    dealerBlackjack: true,
    outcome: 'lose',
    payout: 0,
    net: -10,
  },
  {
    name: 'dealer natural beats a three-card 21',
    hand: { cards: 'T74', bet: 10 },
    dealer: 'AJ',
    dealerBlackjack: true,
    outcome: 'lose',
    payout: 0,
    net: -10,
  },
  {
    name: 'blackjack payout comes from the rule set, not a constant',
    hand: { cards: 'AT', bet: 10 },
    dealer: 'T9',
    rules: { ...VEGAS_STRIP, blackjackPayout: [6, 5] },
    outcome: 'blackjack',
    payout: 22,
    net: 12,
  },

  // Straight comparisons.
  { name: 'higher total wins', hand: { cards: 'TQ', bet: 10 }, dealer: 'T9', outcome: 'win', payout: 20, net: 10 },
  { name: 'equal totals push', hand: { cards: 'T9', bet: 10 }, dealer: 'Q9', outcome: 'push', payout: 10, net: 0 },
  { name: 'lower total loses', hand: { cards: 'T8', bet: 10 }, dealer: 'QT', outcome: 'lose', payout: 0, net: -10 },
  {
    name: 'three-card 21 beats a dealer 20',
    hand: { cards: 'T74', bet: 10 },
    dealer: 'TQ',
    outcome: 'win',
    payout: 20,
    net: 10,
  },
  {
    name: 'dealer bust pays a standing hand',
    hand: { cards: 'T6', bet: 10 },
    dealer: 'T6K',
    outcome: 'win',
    payout: 20,
    net: 10,
  },
  {
    name: 'soft totals compare on their best value',
    hand: { cards: 'A7', bet: 10 },
    dealer: 'T7',
    outcome: 'win',
    payout: 20,
    net: 10,
  },

  // Busting — the house edge.
  {
    name: 'player bust loses to a standing dealer',
    hand: { cards: 'T69', bet: 10 },
    dealer: 'T8',
    outcome: 'bust',
    payout: 0,
    net: -10,
  },
  {
    name: 'player bust still loses when the dealer also busts',
    hand: { cards: 'T6K', bet: 10 },
    dealer: 'T7Q',
    outcome: 'bust',
    payout: 0,
    net: -10,
  },

  // Doubles. The state machine has already doubled `bet`, so nothing here scales it again.
  {
    name: 'doubled win returns twice the doubled stake',
    hand: { cards: 'T63', bet: 20, doubled: true },
    dealer: 'T8',
    outcome: 'win',
    payout: 40,
    net: 20,
  },
  {
    name: 'doubled loss costs the whole doubled stake',
    hand: { cards: 'T62', bet: 20, doubled: true },
    dealer: 'T9',
    outcome: 'lose',
    payout: 0,
    net: -20,
  },
  {
    name: 'doubled bust costs the whole doubled stake',
    hand: { cards: 'T6K', bet: 20, doubled: true },
    dealer: 'T8',
    outcome: 'bust',
    payout: 0,
    net: -20,
  },
  {
    name: 'doubled push returns the doubled stake',
    hand: { cards: 'T63', bet: 20, doubled: true },
    dealer: 'T9',
    outcome: 'push',
    payout: 20,
    net: 0,
  },
  {
    name: 'double after split settles on the doubled stake',
    hand: { cards: 'T63', bet: 20, fromSplit: true, doubled: true },
    dealer: 'T7',
    outcome: 'win',
    payout: 40,
    net: 20,
  },

  // Splits — 21 on a split hand is never a natural.
  {
    name: 'split-ace 21 pays even money, not 3:2',
    hand: { cards: 'AT', bet: 10, fromSplit: true, fromSplitAces: true },
    dealer: 'T9',
    outcome: 'win',
    payout: 20,
    net: 10,
  },
  {
    name: 'split-ace 21 pushes a dealer 21',
    hand: { cards: 'AQ', bet: 10, fromSplit: true, fromSplitAces: true },
    dealer: 'T74',
    outcome: 'push',
    payout: 10,
    net: 0,
  },
  {
    name: 'split-ace 21 loses outright to a dealer natural',
    hand: { cards: 'AT', bet: 10, fromSplit: true, fromSplitAces: true },
    dealer: 'AK',
    dealerBlackjack: true,
    outcome: 'lose',
    payout: 0,
    net: -10,
  },
  {
    name: 'split ten-and-ace 21 pays even money',
    hand: { cards: 'TA', bet: 10, fromSplit: true },
    dealer: 'TQ',
    outcome: 'win',
    payout: 20,
    net: 10,
  },

  // Surrender.
  {
    name: 'surrender returns half the stake',
    hand: { cards: 'T6', bet: 10, surrendered: true },
    dealer: 'T9',
    outcome: 'surrender',
    payout: 5,
    net: -5,
  },
  {
    name: 'surrender returns half even when the dealer would have busted',
    hand: { cards: 'T6', bet: 10, surrendered: true },
    dealer: 'T6K',
    outcome: 'surrender',
    payout: 5,
    net: -5,
  },
  {
    name: 'surrender of an odd stake is not rounded',
    hand: { cards: 'T6', bet: 5, surrendered: true },
    dealer: 'T9',
    outcome: 'surrender',
    payout: 2.5,
    net: -2.5,
  },
];

describe('settleHand', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const settlement = settleHand(
        makeHand(testCase.hand),
        cardsOf(testCase.dealer),
        testCase.dealerBlackjack ?? false,
        testCase.rules ?? VEGAS_STRIP,
        3,
        1,
      );

      expect(settlement.outcome).toBe(testCase.outcome);
      expect(settlement.payout).toBe(testCase.payout);
      expect(settlement.net).toBe(testCase.net);
      expect(settlement.bet).toBe(testCase.hand.bet);
      expect(settlement.seat).toBe(3);
      expect(settlement.handIndex).toBe(1);
    });
  }

  it('always reports net as payout minus bet', () => {
    for (const testCase of CASES) {
      const settlement = settleHand(
        makeHand(testCase.hand),
        cardsOf(testCase.dealer),
        testCase.dealerBlackjack ?? false,
        testCase.rules ?? VEGAS_STRIP,
        0,
        0,
      );
      expect(settlement.net).toBe(settlement.payout - settlement.bet);
    }
  });

  it('never pays a losing hand and never keeps a pushed stake', () => {
    for (const testCase of CASES) {
      const settlement = settleHand(
        makeHand(testCase.hand),
        cardsOf(testCase.dealer),
        testCase.dealerBlackjack ?? false,
        testCase.rules ?? VEGAS_STRIP,
        0,
        0,
      );
      if (settlement.outcome === 'lose' || settlement.outcome === 'bust') expect(settlement.payout).toBe(0);
      if (settlement.outcome === 'push') expect(settlement.net).toBe(0);
    }
  });
});

// --- Insurance -------------------------------------------------------------

describe('settleInsurance', () => {
  const seatWith = (insuranceBet: number): Seat =>
    makeSeat({ index: 2, hands: [{ cards: 'T6', bet: 10 }], insuranceBet });

  it('returns undefined when the seat declined insurance', () => {
    expect(settleInsurance(seatWith(0), true, VEGAS_STRIP)).toBeUndefined();
  });

  it('pays 2:1 when the dealer has a natural', () => {
    expect(settleInsurance(seatWith(5), true, VEGAS_STRIP)).toEqual({
      seat: 2,
      bet: 5,
      payout: 15,
      net: 10,
    });
  });

  it('loses the stake when the dealer has no natural', () => {
    expect(settleInsurance(seatWith(5), false, VEGAS_STRIP)).toEqual({
      seat: 2,
      bet: 5,
      payout: 0,
      net: -5,
    });
  });

  it('exactly cancels a lost base bet — the break-even case that makes it a sucker bet', () => {
    // Base bet 10, insurance 5. Dealer natural: hand loses 10, insurance wins 10.
    const seat = seatWith(5);
    const insurance = settleInsurance(seat, true, VEGAS_STRIP);
    const hand = settleHand(makeHand({ cards: 'T6', bet: 10 }), cardsOf('AK'), true, VEGAS_STRIP, 2, 0);
    expect((insurance?.net ?? 0) + hand.net).toBe(0);
  });
});

// --- Whole-round settlement ------------------------------------------------

describe('settleRound', () => {
  it('settles seats in table order and hands in split order', () => {
    const state = makeState(
      [
        makeSeat({ index: 0, hands: [], occupant: { kind: 'empty' } }),
        makeSeat({ index: 1, hands: [{ cards: 'TQ', bet: 10 }] }),
        makeSeat({ index: 2, hands: [], occupant: { kind: 'bot', policyId: 'perfect', characterId: 'a' } }),
        makeSeat({
          index: 3,
          hands: [
            { cards: 'T8', bet: 10, fromSplit: true },
            { cards: 'T9', bet: 10, fromSplit: true },
            { cards: 'TK', bet: 10, fromSplit: true },
          ],
          occupant: { kind: 'bot', policyId: 'perfect', characterId: 'b' },
        }),
      ],
      'T9',
    );

    const { hands } = settleRound(state);

    expect(hands.map((h) => [h.seat, h.handIndex, h.outcome])).toEqual([
      [1, 0, 'win'],
      [3, 0, 'lose'],
      [3, 1, 'push'],
      [3, 2, 'win'],
    ]);
  });

  it('skips empty seats and seats that sat the round out', () => {
    const state = makeState(
      [
        makeSeat({ index: 0, hands: [], occupant: { kind: 'empty' } }),
        makeSeat({ index: 1, hands: [], occupant: { kind: 'bot', policyId: 'perfect', characterId: 'a' } }),
        makeSeat({ index: 2, hands: [{ cards: 'TQ', bet: 10 }] }),
      ],
      'T9',
    );

    expect(settleRound(state).hands.map((h) => h.seat)).toEqual([2]);
  });

  it('settles a four-hand split with mixed outcomes independently', () => {
    const state = makeState(
      [
        makeSeat({
          index: 4,
          baseBet: 10,
          hands: [
            { cards: 'A7', bet: 10, fromSplit: true, fromSplitAces: true },
            { cards: 'AT', bet: 10, fromSplit: true, fromSplitAces: true },
            { cards: 'T63', bet: 20, fromSplit: true, doubled: true },
            { cards: 'T6K', bet: 10, fromSplit: true },
          ],
        }),
      ],
      'TQ',
    );

    const { hands } = settleRound(state);

    expect(hands.map((h) => ({ outcome: h.outcome, payout: h.payout, net: h.net }))).toEqual([
      { outcome: 'lose', payout: 0, net: -10 },
      // Even money: a split ace is never a natural, so no 3:2 here.
      { outcome: 'win', payout: 20, net: 10 },
      { outcome: 'lose', payout: 0, net: -20 },
      { outcome: 'bust', payout: 0, net: -10 },
    ]);
  });

  it('reports insurance only for the seats that took it', () => {
    const state = makeState(
      [
        makeSeat({ index: 0, hands: [{ cards: 'T6', bet: 10 }], insuranceBet: 5 }),
        makeSeat({ index: 1, hands: [{ cards: 'T7', bet: 20 }] }),
        makeSeat({ index: 2, hands: [{ cards: 'T8', bet: 40 }], insuranceBet: 20 }),
      ],
      'AK',
      true,
    );

    const { hands, insurance } = settleRound(state);

    expect(insurance).toEqual([
      { seat: 0, bet: 5, payout: 15, net: 10 },
      { seat: 2, bet: 20, payout: 60, net: 40 },
    ]);
    expect(hands.every((h) => h.outcome === 'lose')).toBe(true);
  });

  it('treats a dealer natural as such even when the peek flag was never set', () => {
    // A no-peek rule set leaves `hasBlackjack` false until the reveal; the cards
    // are still the truth, and the player's 20 still loses.
    const state = makeState([makeSeat({ index: 0, hands: [{ cards: 'TQ', bet: 10 }] })], 'AK', false);

    expect(settleRound(state).hands[0]?.outcome).toBe('lose');
  });

  it('pays a natural against a dealer who drew to 21', () => {
    const state = makeState([makeSeat({ index: 0, hands: [{ cards: 'AT', bet: 10 }] })], 'T74');
    const settlement = settleRound(state).hands[0];

    expect(settlement?.outcome).toBe('blackjack');
    expect(settlement?.payout).toBe(25);
  });
});
