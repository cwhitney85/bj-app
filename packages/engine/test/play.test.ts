import { describe, expect, it } from 'vitest';

import { compositionOf, type Card, type Rank, type Shoe, type Suit } from '../src/cards.js';
import { eventsOfType, type GameEvent } from '../src/events.js';
import {
  actionView,
  advanceUntilDecision,
  botSeats,
  collectBets,
  createGame,
  flatBettor,
  occupantPolicyId,
  PERFECT_POLICY,
  playerSeatIndex,
  playRound,
  playRounds,
  policyById,
  placeBets,
  seatAt,
  takeInsurance,
  VEGAS_STRIP,
  type BotPolicy,
  type Deciders,
  type Phase,
  type RoundState,
  type SeatConfig,
  type SeatDecider,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

const BANKROLL = 10_000_000;

type SeatSpec = 'player' | 'empty' | BotPolicy;

function game(seed: number, specs: readonly SeatSpec[], bankroll = BANKROLL): RoundState {
  const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => {
    const spec = specs[i] ?? 'empty';
    if (spec === 'empty') return { occupant: { kind: 'empty' } as const, bankroll: 0 };
    if (spec === 'player') return { occupant: { kind: 'player' } as const, bankroll };
    return {
      occupant: { kind: 'bot', policyId: spec.id, characterId: `c${i}` } as const,
      bankroll,
    };
  });
  return createGame({ rules: VEGAS_STRIP, seed, seats });
}

function deciders(entries: readonly (readonly [number, SeatDecider])[]): Deciders {
  return new Map(entries);
}

function flat(policy: BotPolicy, bet: number): SeatDecider {
  return flatBettor(policy, bet);
}

/**
 * Build a shoe with a known card order. Deal order for `n` betting seats is
 * seat0..seatN, dealer up, seat0..seatN, dealer hole.
 */
function stack(ranks: readonly string[]): Shoe {
  const suits: readonly Suit[] = ['S', 'H', 'D', 'C'];
  const cards: Card[] = ranks.map((rank, i) => ({
    rank: rank as Rank,
    suit: suits[i % 4] as Suit,
    id: `${rank}-${i}`,
  }));
  return {
    cards,
    index: 0,
    cutIndex: cards.length, // never reached, so cleanup does not reshuffle
    deckCount: VEGAS_STRIP.deckCount,
    composition: compositionOf(cards),
  };
}

/** The `to` phase of every PhaseChanged event, in order. */
function phaseTrail(events: readonly GameEvent[]): Phase[] {
  return eventsOfType(events, 'PhaseChanged').map((event) => event.to);
}

// --- One round, and the number that identifies it ---------------------------

describe('playRound leaves the table ready for the next round', () => {
  it('returns at the betting phase with the round number one higher', () => {
    const start = game(1, [PERFECT_POLICY]);
    expect(start.phase).toBe('idle');
    expect(start.roundNumber).toBe(0);

    const result = playRound(start, deciders([[0, flat(PERFECT_POLICY, 1000)]]));
    expect(result.roundNumber).toBe(1);
    expect(result.state.phase).toBe('betting');
    expect(result.state.roundNumber).toBe(2);
  });

  it('clears the table so the caller can loop without a bookkeeping step', () => {
    const result = playRound(game(2, [PERFECT_POLICY]), deciders([[0, flat(PERFECT_POLICY, 1000)]]));
    const seat = seatAt(result.state, 0);
    expect(seat.hands).toHaveLength(0);
    expect(seat.baseBet).toBe(0);
    expect(seat.insuranceBet).toBe(0);
    expect(result.state.dealer.cards).toEqual([]);
    expect(result.state.turnSeat).toBe(-1);
  });
});

/**
 * The regression test for the defect that made a round have no identity.
 *
 * `cleanup` used to transition straight to `betting`, and so did `doShuffle`.
 * `startRound` is only reachable from `idle`, so it ran exactly once per *game*:
 * `roundNumber` stuck at 1 forever and `RoundStarted` fired once, ever. Nothing
 * in the suite noticed, because every existing test drove either a single round
 * or a loop that never read the round number back.
 *
 * The report card (SPEC §9) counts hands played from `roundNumber`, and a
 * counterfactual recording (SPEC §7) is identified by the round it replays, so
 * both were reading a number that never moved.
 */
describe('every round is numbered, and numbered exactly once', () => {
  it('increments the round number across many consecutive rounds', () => {
    let state = game(3, [PERFECT_POLICY, PERFECT_POLICY]);
    const bets = deciders([
      [0, flat(PERFECT_POLICY, 1000)],
      [1, flat(PERFECT_POLICY, 1000)],
    ]);

    const played: number[] = [];
    for (let i = 0; i < 60; i++) {
      const result = playRound(state, bets);
      played.push(result.roundNumber);
      state = result.state;
      // The state handed back is always one ahead: it is the round about to start.
      expect(state.roundNumber).toBe(result.roundNumber + 1);
    }

    expect(played).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it('emits exactly one RoundStarted per round, carrying that round’s number', () => {
    const state = game(4, [PERFECT_POLICY, PERFECT_POLICY, PERFECT_POLICY]);
    const bets = deciders([0, 1, 2].map((seat) => [seat, flat(PERFECT_POLICY, 1000)] as const));

    const { events } = playRounds(state, bets, 80);
    const started = eventsOfType(events, 'RoundStarted');

    // 80 rounds were played, so 81 rounds were *started*: the last event opens
    // the betting phase the caller is left sitting in.
    expect(started).toHaveLength(81);
    expect(started.map((event) => event.roundNumber)).toEqual(
      Array.from({ length: 81 }, (_, i) => i + 1),
    );
    // Each one reports where in the shoe its round began.
    for (const event of started) expect(event.shoeIndex).toBeGreaterThanOrEqual(0);
  });

  it('numbers rounds strictly in order with no repeats and no gaps', () => {
    const { events } = playRounds(
      game(5, [PERFECT_POLICY]),
      deciders([[0, flat(PERFECT_POLICY, 500)]]),
      200,
    );
    const numbers = eventsOfType(events, 'RoundStarted').map((event) => event.roundNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe((numbers[i - 1] as number) + 1);
    }
  });
});

// --- The phase cycle --------------------------------------------------------

describe('the phase cycle returns through idle, which is where a round begins', () => {
  it('goes cleanup → idle → betting on an ordinary round', () => {
    const start = game(6, [PERFECT_POLICY]);
    const first = playRound(start, deciders([[0, flat(PERFECT_POLICY, 1000)]]));
    const trail = phaseTrail(first.events);

    expect(trail[0]).toBe('betting'); // idle → betting, i.e. startRound
    expect(trail).toContain('cleanup');
    // The tail of every round is the same three steps, and `idle` is not
    // cosmetic: `startRound` is reachable only from there, and it is the single
    // place a round is numbered and announced.
    expect(trail.slice(-3)).toEqual(['cleanup', 'idle', 'betting']);
  });

  it('goes cleanup → shuffle → idle → betting when the cut card was reached', () => {
    // Long enough to exhaust 75% of a six-deck shoe at least once.
    const { events } = playRounds(
      game(7, [PERFECT_POLICY, PERFECT_POLICY, PERFECT_POLICY]),
      deciders([0, 1, 2].map((seat) => [seat, flat(PERFECT_POLICY, 500)] as const)),
      120,
    );

    const trail = phaseTrail(events);
    const shuffles = trail.filter((phase) => phase === 'shuffle');
    expect(shuffles.length).toBeGreaterThan(0);
    expect(eventsOfType(events, 'ShuffleStarted')).toHaveLength(shuffles.length);

    // Every shuffle sits between a cleanup and an idle, never between a cleanup
    // and a betting: the shoe is replaced and the round still starts in one place.
    for (let i = 0; i < trail.length; i++) {
      if (trail[i] !== 'shuffle') continue;
      expect(trail.slice(i - 1, i + 3)).toEqual(['cleanup', 'shuffle', 'idle', 'betting']);
    }
  });

  it('never opens betting from anywhere but idle', () => {
    const { events } = playRounds(
      game(8, [PERFECT_POLICY, PERFECT_POLICY]),
      deciders([0, 1].map((seat) => [seat, flat(PERFECT_POLICY, 500)] as const)),
      120,
    );
    for (const event of eventsOfType(events, 'PhaseChanged')) {
      if (event.to === 'betting') expect(event.from).toBe('idle');
    }
  });
});

// --- Many rounds ------------------------------------------------------------

describe('playRounds', () => {
  it('carries the round count across a shuffle', () => {
    const start = game(9, [PERFECT_POLICY, PERFECT_POLICY, PERFECT_POLICY, PERFECT_POLICY]);
    const bets = deciders([0, 1, 2, 3].map((seat) => [seat, flat(PERFECT_POLICY, 500)] as const));
    const { state, events } = playRounds(start, bets, 150);

    expect(eventsOfType(events, 'ShuffleStarted').length).toBeGreaterThan(0);
    expect(eventsOfType(events, 'CutCardReached').length).toBe(
      eventsOfType(events, 'ShuffleStarted').length,
    );
    // The number kept counting hands, not shoes. Reshuffling derives the next
    // shoe seed from the current one precisely so that `roundNumber` can stay a
    // true count of rounds played.
    expect(state.roundNumber).toBe(151);
    expect(state.shoe.index).toBeLessThan(state.shoe.cutIndex);
  });

  it('accumulates every round’s events in order', () => {
    const bets = deciders([[0, flat(PERFECT_POLICY, 1000)]]);
    const batched = playRounds(game(10, [PERFECT_POLICY]), bets, 5);

    let state = game(10, [PERFECT_POLICY]);
    const oneByOne: GameEvent[] = [];
    for (let i = 0; i < 5; i++) {
      const result = playRound(state, bets);
      oneByOne.push(...result.events);
      state = result.state;
    }

    expect(JSON.stringify(batched.events)).toEqual(JSON.stringify(oneByOne));
    expect(JSON.stringify(batched.state)).toEqual(JSON.stringify(state));
  });

  it('rejects a round count that is not a positive integer', () => {
    const bets = deciders([[0, flat(PERFECT_POLICY, 1000)]]);
    for (const rounds of [0, -1, 1.5, Number.NaN]) {
      expect(() => playRounds(game(11, [PERFECT_POLICY]), bets, rounds)).toThrow(
        /positive integer/,
      );
    }
  });
});

// --- Preconditions ----------------------------------------------------------

describe('playRound refuses a table it cannot drive', () => {
  it('throws naming every occupied seat with no decider', () => {
    const start = game(12, [PERFECT_POLICY, PERFECT_POLICY, 'player']);
    expect(() => playRound(start, deciders([[0, flat(PERFECT_POLICY, 1000)]]))).toThrow(
      /no decider for occupied seat\(s\) 1, 2/,
    );
  });

  it('does not require a decider for an empty seat', () => {
    const start = game(13, ['empty', PERFECT_POLICY]);
    const result = playRound(start, deciders([[1, flat(PERFECT_POLICY, 1000)]]));
    expect(result.roundNumber).toBe(1);
    expect(eventsOfType(result.events, 'CardDealt').some((event) => event.seat === 1)).toBe(true);
  });

  it('throws rather than answer a decision it was never asked for', () => {
    // A caller that stopped mid-round and then handed the state back has a bug.
    // `advanceToBetting` would otherwise have to guess what the acting seat
    // wanted, which is precisely what round.ts refuses to do.
    const start = game(14, [PERFECT_POLICY]);
    const bets = deciders([[0, flat(PERFECT_POLICY, 1000)]]);
    const midRound = placeBets(advanceUntilDecision(start).state, new Map([[0, 1000]])).state;
    const acting = advanceUntilDecision(midRound).state;
    expect(acting.phase).not.toBe('betting');
    expect(() => playRound(acting, bets)).toThrow(/decision is outstanding/);
  });
});

// --- Betting ----------------------------------------------------------------

describe('a seat that bets nothing sits the round out', () => {
  const sittingOut: SeatDecider = {
    bet: () => 0,
    takeInsurance: () => false,
    act: () => {
      throw new Error('a seat that sat out was asked to act');
    },
  };

  it('deals no cards to it and settles nothing for it', () => {
    const start = game(15, [PERFECT_POLICY, PERFECT_POLICY]);
    const result = playRound(
      start,
      deciders([
        [0, flat(PERFECT_POLICY, 1000)],
        [1, sittingOut],
      ]),
    );

    const dealt = eventsOfType(result.events, 'CardDealt');
    expect(dealt.some((event) => event.seat === 1)).toBe(false);
    expect(eventsOfType(result.events, 'HandSettled').every((event) => event.ref.seat === 0)).toBe(
      true,
    );
    expect(seatAt(result.state, 1).bankroll).toBe(BANKROLL);
  });

  it('throws when every seat sits out, because there is no round to deal', () => {
    const start = game(16, [PERFECT_POLICY, PERFECT_POLICY]);
    expect(() =>
      playRound(
        start,
        deciders([
          [0, sittingOut],
          [1, sittingOut],
        ]),
      ),
    ).toThrow(/must bet/);
  });

  it('collectBets asks only the seats it can drive, and skips a zero', () => {
    const start = advanceUntilDecision(game(17, [PERFECT_POLICY, PERFECT_POLICY, 'player'])).state;
    const bets = collectBets(
      start,
      deciders([
        [0, flat(PERFECT_POLICY, 2500)],
        [1, sittingOut],
        // Seat 2 is the human: the app collects the bot bets here and merges the
        // player's own bet in before calling placeBets itself.
      ]),
    );
    expect([...bets]).toEqual([[0, 2500]]);
  });
});

// --- Insurance --------------------------------------------------------------

/** Seat 0 gets T,7; the dealer shows an ace with a nine in the hole. */
const ACE_UP = stack(['T', 'A', '7', '9', '5', '5', '5', '5']);

describe('insurance is collapsed onto what the seat can actually afford', () => {
  it('takes insurance when the money is there', () => {
    const start = { ...game(18, [PERFECT_POLICY], 100_000), shoe: ACE_UP };
    const result = playRound(start, deciders([[0, flat(policyById('always-insures'), 10_000)]]));
    const taken = eventsOfType(result.events, 'InsuranceTaken');
    expect(taken).toHaveLength(1);
    expect(taken[0]?.amount).toBe(5000);
  });

  it('declines it when half the base bet is more than the seat has left', () => {
    // Bankroll $7, bet $5: after the bet is placed the seat holds $2, and
    // insurance costs $2.50. The personality describes an intent, not a
    // guarantee — and `takeInsurance` in round.ts would throw rather than let a
    // seat stake money it does not have.
    const start = { ...game(19, [PERFECT_POLICY], 700), shoe: ACE_UP };
    const result = playRound(start, deciders([[0, flat(policyById('always-insures'), 500)]]));

    expect(eventsOfType(result.events, 'InsuranceOffered')).toHaveLength(1);
    expect(eventsOfType(result.events, 'InsuranceTaken')).toHaveLength(0);
    expect(eventsOfType(result.events, 'InsuranceDeclined')).toHaveLength(1);
    expect(seatAt(result.state, 0).insuranceBet).toBe(0);
  });

  it('declines it exactly at the boundary and takes it one dollar above', () => {
    // Bet $10, so insurance costs $5. A bankroll of $14 leaves $4 — not enough.
    const short = { ...game(20, [PERFECT_POLICY], 1400), shoe: ACE_UP };
    expect(
      eventsOfType(
        playRound(short, deciders([[0, flat(policyById('always-insures'), 1000)]])).events,
        'InsuranceTaken',
      ),
    ).toHaveLength(0);

    // A bankroll of $15 leaves exactly $5, which covers it.
    const exact = { ...game(20, [PERFECT_POLICY], 1500), shoe: ACE_UP };
    expect(
      eventsOfType(
        playRound(exact, deciders([[0, flat(policyById('always-insures'), 1000)]])).events,
        'InsuranceTaken',
      ),
    ).toHaveLength(1);
  });
});

// --- Money ------------------------------------------------------------------

describe('money is conserved across a long session', () => {
  it('settlements sum exactly to the movement in every bankroll', () => {
    // The same check `sim/simulate.ts` runs, but over a mixed table driven by
    // policies rather than one seat playing the book. It catches a class of bug
    // the aggregate numbers hide entirely: a payout credited to the wrong seat,
    // or a stake deducted twice, leaves the house edge plausible and the
    // bankrolls wrong.
    const specs: readonly BotPolicy[] = [
      PERFECT_POLICY,
      policyById('mimics-dealer'),
      policyById('doubles-twelve'),
      policyById('always-insures'),
      policyById('never-splits'),
    ];
    const start = game(21, specs);
    const bets = deciders(specs.map((policy, i) => [i, flat(policy, 1000)] as const));

    const { state, events } = playRounds(start, bets, 400);

    let settled = 0;
    for (const event of events) {
      if (event.type === 'HandSettled' || event.type === 'InsuranceSettled') settled += event.net;
    }

    let moved = 0;
    for (let i = 0; i < specs.length; i++) moved += seatAt(state, i).bankroll - BANKROLL;

    // Every settlement is a multiple of half a bet, so this is a true equality
    // and not a tolerance.
    expect(moved).toBe(settled);
    // …and something actually happened, so the equality is not 0 === 0.
    expect(eventsOfType(events, 'HandSettled').length).toBeGreaterThan(1500);
    expect(eventsOfType(events, 'InsuranceSettled').length).toBeGreaterThan(10);
    expect(settled).not.toBe(0);
  });

  it('keeps each seat’s bankroll equal to its own settlements alone', () => {
    // Money conservation in aggregate would still pass if two seats' payouts
    // were swapped. This does not.
    const specs: readonly BotPolicy[] = [PERFECT_POLICY, policyById('mimics-dealer')];
    const start = game(22, specs);
    const bets = deciders(specs.map((policy, i) => [i, flat(policy, 1000)] as const));
    const { state, events } = playRounds(start, bets, 200);

    for (let seatIndex = 0; seatIndex < specs.length; seatIndex++) {
      let net = 0;
      for (const event of events) {
        if (event.type === 'HandSettled' && event.ref.seat === seatIndex) net += event.net;
        if (event.type === 'InsuranceSettled' && event.seat === seatIndex) net += event.net;
      }
      expect(seatAt(state, seatIndex).bankroll - BANKROLL, `seat ${seatIndex}`).toBe(net);
    }
  });
});

// --- Reading the table ------------------------------------------------------

describe('the seat helpers the app uses to wire a table up', () => {
  const start = game(23, [
    'player',
    policyById('mimics-dealer'),
    'empty',
    PERFECT_POLICY,
    'empty',
    policyById('never-splits'),
  ]);

  it('lists the bot seats in table order — the input to assignJerk', () => {
    expect(botSeats(start)).toEqual([1, 3, 5]);
  });

  it('finds the human, and reports -1 when there is not one', () => {
    expect(playerSeatIndex(start)).toBe(0);
    expect(playerSeatIndex(game(24, [PERFECT_POLICY, PERFECT_POLICY]))).toBe(-1);
  });

  it('reports a seat’s policy id, and null for anyone who is not a bot', () => {
    expect(occupantPolicyId(start, 1)).toBe('mimics-dealer');
    expect(occupantPolicyId(start, 3)).toBe('perfect');
    expect(occupantPolicyId(start, 0)).toBeNull(); // the human
    expect(occupantPolicyId(start, 2)).toBeNull(); // empty
  });

  it('round-trips through policyById, so a seat can be driven from its own state', () => {
    for (const seatIndex of botSeats(start)) {
      const id = occupantPolicyId(start, seatIndex);
      if (id === null) throw new Error('a bot seat with no policy id');
      expect(policyById(id).id).toBe(id);
    }
  });
});

// --- flatBettor -------------------------------------------------------------

describe('flatBettor', () => {
  it('bets the same amount every round, whatever the bankroll has done', () => {
    const decider = flatBettor(policyById('mimics-dealer'), 2500);
    let state = game(25, [PERFECT_POLICY]);
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      const betting = advanceUntilDecision(state).state;
      seen.push(collectBets(betting, deciders([[0, decider]])).get(0) ?? 0);
      state = playRound(betting, deciders([[0, decider]])).state;
    }
    expect(seen).toEqual(Array.from({ length: 20 }, () => 2500));
  });

  it('takes insurance the way its policy would, not the way the book would', () => {
    const insurer = flatBettor(policyById('always-insures'), 10_000);
    const booker = flatBettor(PERFECT_POLICY, 10_000);
    const start = { ...game(26, [PERFECT_POLICY], 100_000), shoe: ACE_UP };
    expect(
      eventsOfType(playRound(start, deciders([[0, insurer]])).events, 'InsuranceTaken'),
    ).toHaveLength(1);
    expect(
      eventsOfType(playRound(start, deciders([[0, booker]])).events, 'InsuranceTaken'),
    ).toHaveLength(0);
  });

  it('routes actions through decideAction, so an illegal choice names the policy', () => {
    const broken: BotPolicy = {
      id: 'broken-bettor',
      label: 'Broken',
      description: 'Always tries to surrender at a table with no surrender.',
      act: () => 'surrender',
      takeInsurance: () => false,
    };
    const start = { ...game(27, [PERFECT_POLICY], 100_000), shoe: ACE_UP };
    const dealt = advanceUntilDecision(
      placeBets(advanceUntilDecision(start).state, new Map([[0, 1000]])).state,
    ).state;
    const acting = advanceUntilDecision(takeInsurance(dealt, 0, false).state).state;
    expect(() => flatBettor(broken, 1000).act(actionView(acting, 0))).toThrow(/broken-bettor/);
  });
});
