import { describe, expect, it } from 'vitest';

import {
  compositionOf,
  type Card,
  type Rank,
  type Shoe,
  type Suit,
} from '../src/cards.js';
import { eventsOfType, type GameEvent } from '../src/events.js';
import { handTotal, type Action } from '../src/hand.js';
import { VEGAS_STRIP, type RuleSet } from '../src/rules.js';
import {
  advance,
  advanceUntilDecision,
  applyAction,
  createGame,
  pendingDecision,
  placeBets,
  takeInsurance,
  type StepResult,
} from '../src/round.js';
import { seatAt, type RoundState } from '../src/state.js';

// --- Helpers ---------------------------------------------------------------

/**
 * Build a shoe with a known card order so a scenario can be set up exactly.
 * Deal order for one occupied seat is: player, dealer up, player, dealer hole.
 */
function stack(ranks: readonly string[], rules: RuleSet = VEGAS_STRIP): Shoe {
  const suits: readonly Suit[] = ['S', 'H', 'D', 'C'];
  const cards: Card[] = ranks.map((rank, i) => ({
    rank: rank as Rank,
    suit: suits[i % 4] as Suit,
    id: `${rank}-${i}`,
  }));
  return {
    cards,
    index: 0,
    cutIndex: Math.floor(cards.length * rules.penetration),
    deckCount: rules.deckCount,
    composition: compositionOf(cards),
  };
}

function gameWith(shoe: Shoe, seatCount = 1, bankroll = 100_000): RoundState {
  const seats = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => ({
    occupant:
      i === 0
        ? ({ kind: 'player' } as const)
        : i < seatCount
          ? ({ kind: 'bot', policyId: 'perfect', characterId: `c${i}` } as const)
          : ({ kind: 'empty' } as const),
    bankroll,
  }));
  return { ...createGame({ rules: VEGAS_STRIP, seed: 1, seats }), shoe };
}

/** Start a round: idle -> betting -> bets placed -> first decision point. */
function startRound(state: RoundState, bets: ReadonlyMap<number, number>): StepResult {
  const toBetting = advanceUntilDecision(state);
  const placed = placeBets(toBetting.state, bets);
  const dealt = advanceUntilDecision(placed.state);
  return {
    state: dealt.state,
    events: [...toBetting.events, ...placed.events, ...dealt.events],
  };
}

/** Drive every outstanding decision with a fixed policy until betting reopens. */
function playRound(
  state: RoundState,
  policy: (state: RoundState, legal: readonly Action[]) => Action,
): StepResult {
  let current = state;
  const events: GameEvent[] = [];
  for (let guard = 0; guard < 500; guard++) {
    const decision = pendingDecision(current);
    if (decision === null) {
      const step = advance(current);
      current = step.state;
      events.push(...step.events);
      continue;
    }
    if (decision.kind === 'bets') return { state: current, events };
    if (decision.kind === 'insurance') {
      const step = takeInsurance(current, decision.seats[0] as number, false);
      current = step.state;
      events.push(...step.events);
      continue;
    }
    const step = applyAction(current, decision.seat, policy(current, decision.legalActions));
    current = step.state;
    events.push(...step.events);
  }
  throw new Error('Round did not terminate');
}

const alwaysStand = (_: RoundState, legal: readonly Action[]): Action =>
  legal.includes('stand') ? 'stand' : (legal[0] as Action);

// --- Tests -----------------------------------------------------------------

describe('round setup', () => {
  it('rejects a seat list that does not match the rule set', () => {
    expect(() => createGame({ rules: VEGAS_STRIP, seed: 1, seats: [] })).toThrow(/7 seat configs/);
  });

  it('starts idle and opens betting on the first advance', () => {
    const state = gameWith(stack(['T', 'T', 'T', 'T']));
    expect(state.phase).toBe('idle');
    const { state: next, events } = advance(state);
    expect(next.phase).toBe('betting');
    expect(eventsOfType(events, 'RoundStarted')).toHaveLength(1);
  });
});

describe('betting', () => {
  const shoe = stack(['T', '9', '7', '8']);

  it('deducts the bet from the bankroll immediately', () => {
    const { state } = startRound(gameWith(shoe), new Map([[0, 2500]]));
    expect(seatAt(state, 0).bankroll).toBe(97_500);
    expect(seatAt(state, 0).baseBet).toBe(2500);
  });

  it('enforces table limits and bankroll', () => {
    const betting = advanceUntilDecision(gameWith(shoe)).state;
    expect(() => placeBets(betting, new Map([[0, 100]]))).toThrow(/minimum/);
    expect(() => placeBets(betting, new Map([[0, 500_000]]))).toThrow(/maximum/);
    const broke = advanceUntilDecision(gameWith(shoe, 1, 1000)).state;
    expect(() => placeBets(broke, new Map([[0, 50_000]]))).toThrow(/bankroll/);
  });

  it('refuses to deal a round nobody bet on', () => {
    const betting = advanceUntilDecision(gameWith(shoe)).state;
    expect(() => placeBets(betting, new Map())).toThrow(/must bet/);
  });
});

describe('dealing', () => {
  it('deals two cards to each live seat and the dealer, hole card last', () => {
    // seat0, dealer-up, seat1, ... order is player-then-dealer per pass.
    const shoe = stack(['T', '6', '9', 'K']);
    const { state, events } = startRound(gameWith(shoe), new Map([[0, 1000]]));

    expect(seatAt(state, 0).hands[0]?.cards.map((c) => c.rank)).toEqual(['T', '9']);
    expect(state.dealer.cards.map((c) => c.rank)).toEqual(['6', 'K']);
    expect(state.dealer.holeCardRevealed).toBe(false);

    // The hole card must not leak into the event stream before the reveal.
    const dealt = eventsOfType(events, 'CardDealt');
    expect(dealt.filter((e) => e.seat === 'dealer')).toHaveLength(1);
    expect(eventsOfType(events, 'HoleCardPlaced')).toHaveLength(1);
  });

  it('skips seats that did not bet', () => {
    const shoe = stack(['T', '6', '9', 'K', '5', '5', '5', '5']);
    const { state } = startRound(gameWith(shoe, 3), new Map([[0, 1000]]));
    expect(seatAt(state, 1).hands).toHaveLength(0);
    expect(seatAt(state, 2).hands).toHaveLength(0);
  });
});

describe('turn order', () => {
  it('acts in table order, which is what makes third base meaningful', () => {
    // 3 seats bet; deal order cycles seat0, seat1, seat2, dealer.
    const shoe = stack(['T', 'T', 'T', '6', '5', '5', '5', 'K']);
    const { state } = startRound(gameWith(shoe, 3), new Map([[0, 1000], [1, 1000], [2, 1000]]));

    const order: number[] = [];
    let current = state;
    for (let i = 0; i < 3; i++) {
      const decision = pendingDecision(current);
      if (decision?.kind !== 'action') throw new Error('expected an action decision');
      order.push(decision.seat);
      current = applyAction(current, decision.seat, 'stand').state;
    }
    expect(order).toEqual([0, 1, 2]);
  });

  it('refuses an action from a seat whose turn it is not', () => {
    const shoe = stack(['T', 'T', 'T', '6', '5', '5', '5', 'K']);
    const { state } = startRound(gameWith(shoe, 3), new Map([[0, 1000], [1, 1000]]));
    expect(() => applyAction(state, 1, 'stand')).toThrow(/turn/);
  });
});

describe('illegal actions', () => {
  it('never accepts an action outside the legal list', () => {
    const shoe = stack(['T', '6', '9', 'K']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const decision = pendingDecision(state);
    if (decision?.kind !== 'action') throw new Error('expected an action decision');

    expect(decision.legalActions).toContain('hit');
    expect(decision.legalActions).not.toContain('split');
    expect(() => applyAction(state, 0, 'split')).toThrow(/Illegal action/);
    expect(() => applyAction(state, 0, 'surrender')).toThrow(/Illegal action/);
  });

  it('throws rather than hang when advanced while a decision is outstanding', () => {
    const shoe = stack(['T', '6', '9', 'K']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    expect(() => advance(state)).toThrow(/waiting for action/);
  });
});

describe('hitting and busting', () => {
  it('ends the hand on a bust and moves on', () => {
    const shoe = stack(['T', '6', '6', 'K', 'Q']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const { state: after, events } = applyAction(state, 0, 'hit');

    expect(eventsOfType(events, 'HandBusted')).toHaveLength(1);
    // Exactly once — the turn cursor must not re-report the same bust.
    expect(handTotal(seatAt(after, 0).hands[0]?.cards ?? []).total).toBe(26);
    expect(after.phase).toBe('dealerPlay');
  });

  it('lets the same hand act again after a hit that did not bust', () => {
    const shoe = stack(['5', '6', '4', 'K', '3']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const { state: after } = applyAction(state, 0, 'hit');
    const decision = pendingDecision(after);
    expect(decision?.kind).toBe('action');
    if (decision?.kind === 'action') expect(decision.handIndex).toBe(0);
  });
});

describe('doubling', () => {
  it('takes a second bet, deals exactly one card, and ends the hand', () => {
    const shoe = stack(['6', '6', '5', 'K', '9']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const { state: after, events } = applyAction(state, 0, 'double');

    const hand = seatAt(after, 0).hands[0];
    expect(hand?.bet).toBe(2000);
    expect(hand?.cards).toHaveLength(3);
    expect(hand?.doubled).toBe(true);
    expect(eventsOfType(events, 'HandDoubled')[0]?.bet).toBe(2000);
    expect(after.phase).toBe('dealerPlay');
  });
});

describe('splitting', () => {
  it('splits a pair into two hands, each played in turn', () => {
    // seat cards 8,8; dealer 6,K; then 3 (to hand 0), 2 (to hand 1)
    const shoe = stack(['8', '6', '8', 'K', '3', '2', '9', '9']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const { state: after, events } = applyAction(state, 0, 'split');

    const seat = seatAt(after, 0);
    expect(seat.hands).toHaveLength(2);
    expect(seat.bankroll).toBe(98_000); // two $10 bets committed
    expect(eventsOfType(events, 'HandSplit')[0]?.newHandIndex).toBe(1);

    // Hand 0 was topped up to two cards and is live again.
    expect(seat.hands[0]?.cards.map((c) => c.rank)).toEqual(['8', '3']);
    const decision = pendingDecision(after);
    if (decision?.kind !== 'action') throw new Error('expected an action decision');
    expect(decision.handIndex).toBe(0);
  });

  it('gives split aces one card each and no further action', () => {
    const shoe = stack(['A', '6', 'A', 'K', '9', '5', '7', '7']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const { state: after } = applyAction(state, 0, 'split');

    const seat = seatAt(after, 0);
    expect(seat.hands[0]?.cards).toHaveLength(2);
    expect(seat.hands[1]?.cards).toHaveLength(2);
    // Both hands are finished by rule, so the round has moved past the player.
    expect(after.phase).toBe('dealerPlay');
  });

  it('21 on a split ace is paid even money, not 3:2', () => {
    const shoe = stack(['A', '6', 'A', 'K', 'T', '5', '7', '7']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const afterSplit = applyAction(state, 0, 'split').state;
    const { events } = playRound(afterSplit, alwaysStand);

    const settled = eventsOfType(events, 'HandSettled');
    const twentyOne = settled.find((e) => e.ref.handIndex === 0);
    expect(twentyOne?.outcome).toBe('win');
    expect(twentyOne?.net).toBe(1000); // even money, not 1500
  });

  it('stops splitting at the four-hand limit', () => {
    const shoe = stack(['8', '6', '8', 'K', '8', '8', '8', '8', '8', '8', '9', '9']);
    let current = startRound(gameWith(shoe), new Map([[0, 1000]])).state;
    for (let i = 0; i < 3; i++) {
      current = applyAction(current, 0, 'split').state;
    }
    expect(seatAt(current, 0).hands).toHaveLength(4);
    const decision = pendingDecision(current);
    if (decision?.kind !== 'action') throw new Error('expected an action decision');
    expect(decision.legalActions).not.toContain('split');
  });
});

describe('blackjack and the dealer peek', () => {
  it('pays a natural 3:2', () => {
    // Player A,K; dealer 6,9 — a 6 upcard means no peek, and a natural needs no
    // decision from anyone, so the round runs start to finish without ever
    // stopping. The settlement events are therefore in this event list already;
    // there is nothing left for playRound to drive.
    const shoe = stack(['A', '6', 'K', '9', '5']);
    const { state, events } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    expect(state.phase).toBe('betting');

    const settled = eventsOfType(events, 'HandSettled')[0];
    expect(settled?.outcome).toBe('blackjack');
    expect(settled?.net).toBe(1500); // $10 at 3:2
  });

  it('ends the round immediately when the dealer peeks to a natural', () => {
    // Dealer shows an ace with a ten in the hole; nobody gets to act.
    const shoe = stack(['T', 'A', '9', 'K']);
    const { state, events } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    // Insurance is offered first on an ace upcard.
    const decision = pendingDecision(state);
    expect(decision?.kind).toBe('insurance');
    const declined = takeInsurance(state, 0, false).state;
    const played = playRound(declined, alwaysStand);

    expect(eventsOfType(played.events, 'TurnStarted')).toHaveLength(0);
    expect(eventsOfType(played.events, 'HoleCardRevealed')[0]?.dealerBlackjack).toBe(true);
    expect(eventsOfType(played.events, 'HandSettled')[0]?.outcome).toBe('lose');
    expect(eventsOfType(events, 'InsuranceOffered')).toHaveLength(1);
  });

  it('pushes a natural against a natural', () => {
    const shoe = stack(['A', 'A', 'K', 'K']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const declined = takeInsurance(state, 0, false).state;
    const { events } = playRound(declined, alwaysStand);
    const settled = eventsOfType(events, 'HandSettled')[0];
    expect(settled?.outcome).toBe('push');
    expect(settled?.net).toBe(0);
  });
});

describe('insurance', () => {
  it('is offered only on an ace upcard and pays 2:1 when the dealer has a natural', () => {
    const shoe = stack(['T', 'A', '9', 'K']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 10_000]]));
    const taken = takeInsurance(state, 0, true).state;
    expect(seatAt(taken, 0).insuranceBet).toBe(5000);

    const { events } = playRound(taken, alwaysStand);
    const insurance = eventsOfType(events, 'InsuranceSettled')[0];
    expect(insurance?.net).toBe(10_000); // 2:1 on a 5000 stake
    // Hand loses $100, insurance wins $100: the classic wash.
    expect(eventsOfType(events, 'HandSettled')[0]?.net).toBe(-10_000);
  });

  it('is not offered on a ten upcard, which is the common misconception', () => {
    const shoe = stack(['9', 'K', '8', '9']);
    const { state, events } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    expect(eventsOfType(events, 'InsuranceOffered')).toHaveLength(0);
    expect(pendingDecision(state)?.kind).toBe('action');
  });

  it('rejects a second answer from the same seat', () => {
    const shoe = stack(['T', 'A', '9', '9']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const declined = takeInsurance(state, 0, false).state;
    expect(() => takeInsurance(declined, 0, false)).toThrow(/already answered/);
  });
});

describe('dealer play', () => {
  it('stands on soft 17 under Vegas Strip rules', () => {
    const shoe = stack(['T', 'A', '9', '6']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const declined = takeInsurance(state, 0, false).state;
    const { events } = playRound(declined, alwaysStand);
    expect(eventsOfType(events, 'DealerDrew')).toHaveLength(0);
    expect(eventsOfType(events, 'DealerStood')[0]?.total).toBe(17);
  });

  it('does not draw when every player hand has already busted', () => {
    // Player busts; the dealer's 6 up would otherwise draw and burn cards.
    // The stack is padded past what the round needs so that the cut card
    // (75% of 8 cards = index 6) sits beyond the 5 cards actually dealt —
    // otherwise cleanup reshuffles and resets the index we are asserting on.
    const shoe = stack(['T', '6', '6', 'K', 'Q', '5', '5', '5']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const busted = applyAction(state, 0, 'hit').state;
    const before = busted.shoe.index;
    const { events, state: after } = playRound(busted, alwaysStand);

    expect(eventsOfType(events, 'DealerDrew')).toHaveLength(0);
    expect(after.shoe.index).toBe(before);
  });
});

describe('money', () => {
  it('conserves the bankroll on a push', () => {
    const shoe = stack(['T', 'T', '9', '9']);
    const start = gameWith(shoe);
    const { state } = startRound(start, new Map([[0, 2500]]));
    const { state: after } = playRound(state, alwaysStand);
    expect(seatAt(after, 0).bankroll).toBe(100_000);
  });

  it('returns stake plus profit on a doubled win', () => {
    // Player 6,5 = 11 doubles into a 9 for 20. Dealer 6,K = 16 must draw and
    // catches a ten for 26, so the doubled hand wins.
    const shoe = stack(['6', '6', '5', 'K', '9', 'T']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const doubled = applyAction(state, 0, 'double').state;
    expect(seatAt(doubled, 0).bankroll).toBe(98_000); // both halves of the stake are down

    const { state: after } = playRound(doubled, alwaysStand);
    // The $20 at risk comes back as $40: stake plus profit, not profit alone.
    expect(seatAt(after, 0).bankroll).toBe(102_000);
  });

  it('keeps the whole doubled stake on a doubled loss', () => {
    // Same opening, but the dealer's 16 catches a 5 for 21 and the 20 loses.
    const shoe = stack(['6', '6', '5', 'K', '9', '5']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const doubled = applyAction(state, 0, 'double').state;
    const { state: after } = playRound(doubled, alwaysStand);
    expect(seatAt(after, 0).bankroll).toBe(98_000);
  });

  it('clears all bets and hands at cleanup', () => {
    const shoe = stack(['T', 'T', '9', '9']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 2500]]));
    const { state: after } = playRound(state, alwaysStand);
    const seat = seatAt(after, 0);
    expect(seat.hands).toHaveLength(0);
    expect(seat.baseBet).toBe(0);
    expect(seat.insuranceBet).toBe(0);
    expect(after.phase).toBe('betting');
  });
});

describe('shoe lifecycle', () => {
  it('reaches the cut card once and reshuffles before the next round', () => {
    const state = createGame({
      rules: VEGAS_STRIP,
      seed: 42,
      seats: Array.from({ length: 7 }, (_, i) => ({
        occupant: i === 0 ? ({ kind: 'player' } as const) : ({ kind: 'empty' } as const),
        bankroll: 10_000_000,
      })),
    });

    let current = state;
    const allEvents: GameEvent[] = [];
    for (let round = 0; round < 60; round++) {
      const started = startRound(current, new Map([[0, 500]]));
      const played = playRound(started.state, alwaysStand);
      current = played.state;
      allEvents.push(...started.events, ...played.events);
    }

    const cutCards = eventsOfType(allEvents, 'CutCardReached');
    const shuffles = eventsOfType(allEvents, 'ShuffleStarted');
    expect(cutCards.length).toBeGreaterThan(0);
    // Every cut card must be followed by exactly one shuffle.
    expect(shuffles).toHaveLength(cutCards.length);
    expect(current.shoe.index).toBeLessThan(current.shoe.cutIndex);
  });
});

describe('golden-seed replay', () => {
  /** Play a fixed number of rounds with a deterministic policy. */
  function session(seed: number): readonly GameEvent[] {
    let current = createGame({
      rules: VEGAS_STRIP,
      seed,
      seats: Array.from({ length: 7 }, (_, i) => ({
        occupant:
          i < 3
            ? i === 0
              ? ({ kind: 'player' } as const)
              : ({ kind: 'bot', policyId: 'perfect', characterId: `c${i}` } as const)
            : ({ kind: 'empty' } as const),
        bankroll: 10_000_000,
      })),
    });

    const bets = new Map([[0, 1000], [1, 1000], [2, 1000]]);
    const events: GameEvent[] = [];
    // A policy that exercises every branch but stays a pure function of state.
    const policy = (state: RoundState, legal: readonly Action[]): Action => {
      const decision = pendingDecision(state);
      if (decision?.kind !== 'action') throw new Error('expected an action decision');
      const hand = seatAt(state, decision.seat).hands[decision.handIndex];
      const { total } = handTotal(hand?.cards ?? []);
      if (legal.includes('split') && total <= 16) return 'split';
      if (legal.includes('double') && total === 11) return 'double';
      if (legal.includes('hit') && total < 17) return 'hit';
      return 'stand';
    };

    for (let round = 0; round < 40; round++) {
      const started = startRound(current, bets);
      const played = playRound(started.state, policy);
      current = played.state;
      events.push(...started.events, ...played.events);
    }
    return events;
  }

  it('reproduces an identical event stream from the same seed', () => {
    expect(JSON.stringify(session(12345))).toEqual(JSON.stringify(session(12345)));
  });

  it('produces a different stream from a different seed', () => {
    expect(JSON.stringify(session(12345))).not.toEqual(JSON.stringify(session(999)));
  });
});

describe('purity', () => {
  it('never mutates the state passed in', () => {
    const shoe = stack(['8', '6', '8', 'K', '3', '2', '9', '9']);
    const { state } = startRound(gameWith(shoe), new Map([[0, 1000]]));
    const snapshot = JSON.stringify(state);
    applyAction(state, 0, 'split');
    applyAction(state, 0, 'hit');
    advanceUntilDecision(state);
    expect(JSON.stringify(state)).toEqual(snapshot);
  });
});
