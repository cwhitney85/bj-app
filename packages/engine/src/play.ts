/**
 * Driving a round with seated deciders.
 *
 * `round.ts` never invents a decision — it stops and reports what it needs.
 * This module is the counterpart: given something that will answer for each
 * seat, it runs a whole round through the same public door a human player uses
 * (`placeBets` / `takeInsurance` / `applyAction`). No shortcut, no private
 * access. That is what makes the counterfactual replay in `replay.ts` an honest
 * comparison rather than a re-simulation.
 *
 * Deciding and driving are kept apart on purpose. A `BotPolicy` knows how to
 * play a hand; it does not know how to run a table, how much to bet, or when a
 * round is over. Those are this file's business.
 */

import type { GameEvent } from './events.js';
import type { Action } from './hand.js';
import {
  advance,
  applyAction,
  pendingDecision,
  placeBets,
  takeInsurance,
  type StepResult,
} from './round.js';
import { decideAction, type BotPolicy } from './bots.js';
import { isOccupied, seatAt, type RoundState } from './state.js';
import { actionView, betView, insuranceView, type ActionView, type BetView, type InsuranceView } from './view.js';

/**
 * Everything one seat needs to answer for itself over a whole round.
 *
 * Split from `BotPolicy` because betting is a table concern, not a personality:
 * a bot with a bad habit still bets the same way a careful one does, and the
 * human player's seat is driven by a `SeatDecider` during replay even though
 * the human is not a bot.
 */
export type SeatDecider = {
  /** Stake for the coming round. Return 0 to sit it out. */
  bet(view: BetView): number;
  takeInsurance(view: InsuranceView): boolean;
  act(view: ActionView): Action;
};

/** Deciders by seat index. A seat absent from the map cannot be driven. */
export type Deciders = ReadonlyMap<number, SeatDecider>;

/** Wrap a policy with a flat bet — the MVP's only betting behaviour (SPEC §2). */
export function flatBettor(policy: BotPolicy, bet: number): SeatDecider {
  return {
    bet: () => bet,
    takeInsurance: (view) => policy.takeInsurance(view),
    act: (view) => decideAction(policy, view),
  };
}

export type RoundResult = StepResult & {
  /** Rounds are counted by `roundNumber`; this is the one that just finished. */
  readonly roundNumber: number;
};

/**
 * Play exactly one round to completion.
 *
 * Precondition: every occupied seat has a decider, and at least one of them
 * bets. Both throw if violated — a missing decider would otherwise hang the
 * loop, and a table where nobody bets is a caller bug that `placeBets` already
 * names.
 *
 * Postcondition: the returned state is at the start of the *next* round, i.e.
 * phase `betting` with `roundNumber` one higher than the round just played.
 * Cleanup and any shuffle have already happened, so the caller can loop on this
 * function without a bookkeeping step in between.
 */
export function playRound(state: RoundState, deciders: Deciders): RoundResult {
  const events: GameEvent[] = [];
  let current = advanceToBetting(state, events);
  const roundNumber = current.roundNumber;

  requireDeciders(current, deciders);
  current = apply(events, placeBets(current, collectBets(current, deciders)));

  let guard = 0;
  while (current.roundNumber === roundNumber) {
    if (++guard > 10_000) throw new Error('playRound: the round never finished');
    const decision = pendingDecision(current);

    if (decision === null) {
      current = apply(events, advance(current));
      continue;
    }

    switch (decision.kind) {
      // Reaching `bets` again means the round is over: cleanup and any shuffle
      // have run and `startRound` has bumped the number, so the loop condition
      // has already ended us. Getting here is therefore impossible unless the
      // round counter stopped moving — the exact defect that made a round have
      // no identity at all.
      case 'bets':
        throw new Error('playRound: reached betting again without the round number advancing');

      case 'insurance':
        for (const seatIndex of decision.seats) {
          const decider = requireDecider(deciders, seatIndex);
          const view = insuranceView(current, seatIndex, decision.cost);
          // A decider that always insures may not be able to afford it. Collapse
          // the wish onto what is possible here rather than in each policy, for
          // the same reason `strategy.ts` collapses a chart cell onto a legal
          // action: the personality describes an intent, not a guarantee.
          const wants = decider.takeInsurance(view);
          const stake = view.seat.baseBet * decision.cost;
          const take = wants && stake <= view.seat.bankroll;
          current = apply(events, takeInsurance(current, seatIndex, take));
        }
        break;

      case 'action': {
        const decider = requireDecider(deciders, decision.seat);
        const action = decider.act(actionView(current, decision.seat));
        current = apply(events, applyAction(current, decision.seat, action));
        break;
      }
    }
  }

  return { state: current, events, roundNumber };
}

/** Play `rounds` consecutive rounds, accumulating every event. */
export function playRounds(state: RoundState, deciders: Deciders, rounds: number): StepResult {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`rounds must be a positive integer, got ${rounds}`);
  }
  const events: GameEvent[] = [];
  let current = state;
  for (let i = 0; i < rounds; i++) {
    const result = playRound(current, deciders);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

/**
 * Ask each occupied seat for its stake.
 *
 * Exported because the app (M4) collects bot bets this way and then merges the
 * human's own bet in before calling `placeBets` itself — the human seat is the
 * one that will not have a `SeatDecider`.
 */
export function collectBets(state: RoundState, deciders: Deciders): Map<number, number> {
  const bets = new Map<number, number>();
  for (const seat of state.seats) {
    if (!isOccupied(seat)) continue;
    const decider = deciders.get(seat.index);
    if (decider === undefined) continue;
    const amount = decider.bet(betView(state, seat.index));
    if (amount > 0) bets.set(seat.index, amount);
  }
  return bets;
}

// --- Helpers ---------------------------------------------------------------

/** Run the automatic phases that lead into the next betting phase. */
function advanceToBetting(state: RoundState, events: GameEvent[]): RoundState {
  let current = state;
  let guard = 0;
  while (current.phase !== 'betting') {
    if (++guard > 100) throw new Error(`playRound: cannot reach betting from "${state.phase}"`);
    if (pendingDecision(current) !== null) {
      throw new Error(`playRound: a decision is outstanding in phase "${current.phase}"`);
    }
    const step = advance(current);
    current = step.state;
    events.push(...step.events);
  }
  return current;
}

/** Drain a step's events into the round's list and yield its state. */
function apply(events: GameEvent[], step: StepResult): RoundState {
  events.push(...step.events);
  return step.state;
}

function requireDeciders(state: RoundState, deciders: Deciders): void {
  const missing = state.seats
    .filter((seat) => isOccupied(seat) && !deciders.has(seat.index))
    .map((seat) => seat.index);
  if (missing.length > 0) {
    throw new Error(`playRound: no decider for occupied seat(s) ${missing.join(', ')}`);
  }
}

function requireDecider(deciders: Deciders, seatIndex: number): SeatDecider {
  const decider = deciders.get(seatIndex);
  if (decider === undefined) throw new Error(`playRound: no decider for seat ${seatIndex}`);
  return decider;
}

/** Seat indexes holding a bot, in table order — the input to `assignJerk`. */
export function botSeats(state: RoundState): readonly number[] {
  return state.seats.filter((seat) => seat.occupant.kind === 'bot').map((seat) => seat.index);
}

/** The seat the human is in, or -1. */
export function playerSeatIndex(state: RoundState): number {
  return state.seats.find((seat) => seat.occupant.kind === 'player')?.index ?? -1;
}

/** Convenience for callers that hold a seat index rather than a seat. */
export function occupantPolicyId(state: RoundState, seatIndex: number): string | null {
  const occupant = seatAt(state, seatIndex).occupant;
  return occupant.kind === 'bot' ? occupant.policyId : null;
}
