import { describe, expect, it } from 'vitest';

import type { Card } from '../src/cards.js';
import { visibleCards } from '../src/index.js';
import {
  actionView,
  advance,
  advanceUntilDecision,
  applyAction,
  betView,
  createGame,
  decideAction,
  insuranceView,
  JERK_POLICIES,
  pendingDecision,
  PERFECT_POLICY,
  placeBets,
  seatAt,
  tableView,
  takeInsurance,
  VEGAS_STRIP,
  type BotPolicy,
  type RoundState,
  type SeatConfig,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

const BET = 1000;

/**
 * A five-handed table: the human at first base and four bots behind them, each
 * with a different habit. The mix is not decoration — a table of perfect players
 * splits and doubles rarely, and the censorship claim has to hold on the busy
 * hands too.
 */
function crowdedTable(seed: number): RoundState {
  const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => ({
    occupant:
      i === 0
        ? ({ kind: 'player' } as const)
        : i < 5
          ? ({ kind: 'bot', policyId: policyAt(i).id, characterId: `c${i}` } as const)
          : ({ kind: 'empty' } as const),
    bankroll: i < 5 ? 100_000_000 : 0,
  }));
  return createGame({ rules: VEGAS_STRIP, seed, seats });
}

function policyAt(seatIndex: number): BotPolicy {
  if (seatIndex === 0) return PERFECT_POLICY;
  const policy = JERK_POLICIES[(seatIndex - 1) % JERK_POLICIES.length];
  if (policy === undefined) throw new Error('JERK_POLICIES is empty');
  return policy;
}

const BETS = new Map([0, 1, 2, 3, 4].map((seat) => [seat, BET] as const));

/**
 * Drive `rounds` whole rounds, calling `visit` at every point where some seat
 * has to choose. Written out here rather than reusing `playRound` because the
 * check needs both the projection a seat is handed *and* the private state it
 * was projected from, and no policy is ever given the second.
 */
function walkDecisionPoints(
  seed: number,
  rounds: number,
  visit: (state: RoundState, seatIndex: number, kind: 'action' | 'insurance') => void,
): void {
  let state = crowdedTable(seed);
  for (let round = 0; round < rounds; round++) {
    state = placeBets(advanceUntilDecision(state).state, BETS).state;
    for (let guard = 0; guard < 5000; guard++) {
      const decision = pendingDecision(state);
      if (decision === null) {
        state = advance(state).state;
        continue;
      }
      if (decision.kind === 'bets') break;
      if (decision.kind === 'insurance') {
        for (const seatIndex of decision.seats) {
          visit(state, seatIndex, 'insurance');
          const view = insuranceView(state, seatIndex, decision.cost);
          const policy = policyAt(seatIndex);
          state = takeInsurance(state, seatIndex, policy.takeInsurance(view)).state;
        }
        continue;
      }
      visit(state, decision.seat, 'action');
      const policy = policyAt(decision.seat);
      const action = decideAction(policy, actionView(state, decision.seat));
      state = applyAction(state, decision.seat, action).state;
    }
  }
}

/** Anything shaped like a card. Structural, so a copy is caught as well as the original. */
function isCard(value: object): value is Card {
  const candidate = value as Partial<Card>;
  return (
    typeof candidate.rank === 'string' &&
    typeof candidate.suit === 'string' &&
    typeof candidate.id === 'string'
  );
}

/**
 * Every card reachable from an object graph, however deeply nested.
 *
 * The point of walking the graph rather than reading the fields we happen to
 * know about is that a future field on `TableView` — a discard tray, a shoe
 * snapshot, a "dealer hand so far" convenience — would leak the hole card
 * without anyone editing this test. A structural sweep notices; a field-by-field
 * assertion does not.
 */
function reachableCards(root: unknown): Card[] {
  const found: Card[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (isCard(value)) {
      found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const key of Object.keys(value)) {
      walk((value as Record<string, unknown>)[key]);
    }
  };
  walk(root);
  return found;
}

function holeCardOf(state: RoundState): Card {
  const hole = state.dealer.cards[1];
  if (hole === undefined) throw new Error('the dealer has no hole card');
  return hole;
}

// --- The dealer's hand -----------------------------------------------------

describe('tableView shows the dealer exactly what a player can see', () => {
  it('shows one dealer card before the reveal and the whole hand after it', () => {
    let state = placeBets(advanceUntilDecision(crowdedTable(7)).state, BETS).state;
    state = advanceUntilDecision(state).state;

    const before = tableView(state);
    expect(before.holeCardRevealed).toBe(false);
    expect(state.dealer.cards).toHaveLength(2); // the hole card exists...
    expect(before.dealerCards).toHaveLength(1); // ...and the view does not carry it
    expect(before.dealerCards[0]).toEqual(before.dealerUpcard);

    // Run the round out. The dealer reveals and draws, and now the view has to
    // show all of it: after the reveal there is nothing left to hide.
    let final = state;
    for (let guard = 0; guard < 500 && final.dealer.holeCardRevealed === false; guard++) {
      const decision = pendingDecision(final);
      if (decision === null) {
        final = advance(final).state;
      } else if (decision.kind === 'insurance') {
        final = takeInsurance(final, decision.seats[0] as number, false).state;
      } else if (decision.kind === 'action') {
        final = applyAction(final, decision.seat, 'stand').state;
      } else {
        break;
      }
    }

    const after = tableView(final);
    expect(after.holeCardRevealed).toBe(true);
    expect(after.dealerCards).toEqual(final.dealer.cards);
    expect(after.dealerCards.length).toBeGreaterThanOrEqual(2);
  });

  it('never reports the dealer as holding a blackjack it has not turned over', () => {
    // `DealerState.hasBlackjack` is set at the deal and is the single most
    // damaging field a bot could read. It has no counterpart on the projection
    // at all, so this is a check that no such field quietly appears.
    let state = placeBets(advanceUntilDecision(crowdedTable(11)).state, BETS).state;
    state = advanceUntilDecision(state).state;
    expect(Object.keys(tableView(state))).not.toContain('hasBlackjack');
  });
});

// --- The censorship boundary -----------------------------------------------

describe('the hole card is unreachable from anything a seat is handed', () => {
  it('stays hidden at every decision point across many rounds', () => {
    let actionPoints = 0;
    let insurancePoints = 0;
    let concealedPoints = 0;

    walkDecisionPoints(20260807, 400, (state, seatIndex, kind) => {
      if (kind === 'action') actionPoints++;
      else insurancePoints++;

      const hole = holeCardOf(state);
      const view =
        kind === 'action' ? actionView(state, seatIndex) : insuranceView(state, seatIndex, 0.5);
      const cards = reachableCards(view);

      // Compare by identity, never by rank. The hole card's *rank* is very often
      // legitimately on the table — a 6 in the hole while somebody holds a 6 is
      // an ordinary hand, and a test that flagged it would be asserting that the
      // deck contains one of each card. What must never be reachable is this
      // particular physical card, so the comparison is the object itself, and
      // its `id` as well so that a structural copy cannot slip past `===`.
      expect(cards, `seat ${seatIndex} could reach the hole card object`).not.toContain(hole);
      expect(
        cards.map((card) => card.id),
        `seat ${seatIndex} could reach a copy of the hole card`,
      ).not.toContain(hole.id);

      if (!state.dealer.holeCardRevealed) concealedPoints++;
    });

    // A censorship test that saw no decision points would pass by doing nothing.
    expect(actionPoints).toBeGreaterThan(2000);
    expect(insurancePoints).toBeGreaterThan(50);
    // Every decision a seat makes happens before the reveal, by construction:
    // once the hole card is face up nobody has a choice left.
    expect(concealedPoints).toBe(actionPoints + insurancePoints);
  });

  it('does not leak it through the bet view either, which is handed out mid-shoe', () => {
    // `betView` is taken at the betting phase, when the dealer holds nothing —
    // but the previous round's cards are still in play objects, so this is worth
    // pinning rather than assuming.
    let state = placeBets(advanceUntilDecision(crowdedTable(3)).state, BETS).state;
    state = advanceUntilDecision(state).state;
    const hole = holeCardOf(state);

    // Finish the round, then look at the next round's bet view.
    let next = state;
    for (let guard = 0; guard < 500; guard++) {
      const decision = pendingDecision(next);
      if (decision === null) {
        next = advance(next).state;
        continue;
      }
      if (decision.kind === 'bets') break;
      if (decision.kind === 'insurance') {
        next = takeInsurance(next, decision.seats[0] as number, false).state;
        continue;
      }
      next = applyAction(next, decision.seat, 'stand').state;
    }

    expect(reachableCards(betView(next, 0))).toEqual([]);
    expect(reachableCards(betView(next, 0)).map((card) => card.id)).not.toContain(hole.id);
  });
});

// --- Agreement with the rest of the engine ---------------------------------

describe('the view agrees with the engine it is projecting', () => {
  it('carries the same visible cards knowledge.ts computes', () => {
    // `unseenComposition` in `current-round` mode is derived from
    // `visibleCards`. If the view disagreed with it, a bot and the coaching
    // layer would be reasoning about two different tables.
    let checked = 0;
    walkDecisionPoints(99, 80, (state, seatIndex, kind) => {
      if (kind !== 'action') return;
      const view = actionView(state, seatIndex);
      expect(view.table.visibleCards).toEqual(visibleCards(state));
      checked++;
    });
    expect(checked).toBeGreaterThan(400);
  });

  it('hands over legal actions that match what the state machine will accept', () => {
    let checked = 0;
    walkDecisionPoints(1234, 80, (state, seatIndex, kind) => {
      if (kind !== 'action') return;
      const decision = pendingDecision(state);
      if (decision?.kind !== 'action') throw new Error('expected an action decision');
      const view = actionView(state, seatIndex);
      expect(view.legalActions).toEqual(decision.legalActions);
      expect(view.handIndex).toBe(decision.handIndex);
      expect(view.hand).toEqual(seatAt(state, seatIndex).hands[decision.handIndex]);
      checked++;
    });
    expect(checked).toBeGreaterThan(400);
  });

  it('reports the round number and shoe position, which are public at a real table', () => {
    let state = placeBets(advanceUntilDecision(crowdedTable(5)).state, BETS).state;
    state = advanceUntilDecision(state).state;
    const view = tableView(state);
    expect(view.roundNumber).toBe(state.roundNumber);
    expect(view.shoeIndex).toBe(state.shoe.index);
    expect(view.rules).toBe(VEGAS_STRIP);
  });
});

// --- Preconditions ---------------------------------------------------------

describe('the projections throw rather than invent a table', () => {
  it('tableView refuses to project a round that has not been dealt', () => {
    const idle = crowdedTable(1);
    expect(() => tableView(idle)).toThrow(/no dealer upcard/);

    const betting = advanceUntilDecision(idle).state;
    expect(betting.phase).toBe('betting');
    expect(() => tableView(betting)).toThrow(/no dealer upcard/);
  });

  it('actionView refuses a seat that is not acting', () => {
    let state = placeBets(advanceUntilDecision(crowdedTable(5)).state, BETS).state;
    state = advanceUntilDecision(state).state;
    const decision = pendingDecision(state);
    if (decision?.kind !== 'action') throw new Error('expected seat 0 to be first to act');
    expect(decision.seat).toBe(0);

    // Seat 1 is in the round but has not been reached yet.
    expect(seatAt(state, 1).activeHandIndex).toBe(-1);
    expect(() => actionView(state, 1)).toThrow(/seat 1 is not acting/);
    // Seat 5 is not even in the round.
    expect(() => actionView(state, 5)).toThrow(/seat 5 is not acting/);
    // And the seat that *is* acting projects cleanly.
    expect(actionView(state, 0).legalActions.length).toBeGreaterThan(0);
  });

  it('actionView refuses a hand with nothing left to decide', () => {
    // A seat whose active hand has no legal actions is an engine bug, not a
    // decision point; inventing an empty list would push it into a policy.
    let state = placeBets(advanceUntilDecision(crowdedTable(5)).state, BETS).state;
    state = advanceUntilDecision(state).state;
    const acting = seatAt(state, 0);
    const stood = { ...acting, hands: acting.hands.map((hand) => ({ ...hand, stood: true })) };
    const frozen: RoundState = {
      ...state,
      seats: state.seats.map((seat) => (seat.index === 0 ? stood : seat)),
    };
    expect(() => actionView(frozen, 0)).toThrow(/no legal actions/);
  });
});
