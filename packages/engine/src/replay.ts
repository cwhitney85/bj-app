/**
 * The third-base myth demo (SPEC §7).
 *
 * Nearly every casual player believes a bad player at third base hurts the
 * whole table. It is false, and this module is the proof: replay the exact
 * round from its exact starting state with one seat playing correctly, and show
 * the player what would have happened.
 *
 * Three things make the demo honest, and all three are properties this codebase
 * already had before this file existed:
 *
 * 1. **The shoe is pre-shuffled** (M1 decision 1), so the card *order* is fixed
 *    by the recorded start state. Nothing here re-derives it.
 * 2. **Bot policies see only the public view** (`view.ts`), so the corrected
 *    seat cannot play better than a real player could.
 * 3. **Replay drives the same state machine through the same public door**
 *    (`play.ts`). Nothing re-implements a round.
 *
 * The one thing that *does* change is which cards reach the player — and that
 * is the entire point. A jerk who takes an extra card shifts every card behind
 * them. The demo does not claim the player's cards stay the same; it shows what
 * they would have been, which is what the myth is actually about.
 *
 * A recording is derived from the **event stream**, not from a bespoke hook.
 * `BetPlaced`, `InsuranceTaken` / `InsuranceDeclined` and `PlayerActed` already
 * carry every decision anyone made, so the app records a round by keeping the
 * state it started from and the events it produced — which it has anyway.
 */

import type { GameEvent } from './events.js';
import type { Action } from './hand.js';
import { PERFECT_POLICY, decideAction, type BotPolicy } from './bots.js';
import { flatBettor, playRound, type Deciders, type SeatDecider } from './play.js';
import type { StepResult } from './round.js';
import type { HandOutcome } from './settle.js';
import { isOccupied, type RoundState } from './state.js';
import type { ActionView, BetView, InsuranceView } from './view.js';

// --- Recording -------------------------------------------------------------

export type RecordedDecision =
  | { readonly kind: 'bet'; readonly seat: number; readonly amount: number }
  | { readonly kind: 'insurance'; readonly seat: number; readonly take: boolean }
  | {
      readonly kind: 'action';
      readonly seat: number;
      readonly handIndex: number;
      readonly action: Action;
    };

/**
 * Everything needed to replay one round: where it started, and what everyone
 * chose. Plain serialisable data, like `RoundState` itself, so a session's
 * recordings can be persisted (SPEC §9) and replayed later.
 */
export type RoundRecording = {
  /** The state at the betting phase, *before* any bet was placed. */
  readonly state: RoundState;
  readonly roundNumber: number;
  readonly decisions: readonly RecordedDecision[];
};

/**
 * Build a recording from a round's start state and the events it produced.
 *
 * Precondition: `state` is at the betting phase with no bets placed, and
 * `events` covers exactly one round. The second is checked the only way it can
 * be — a seat that bet twice means the event list spans two rounds, which would
 * replay as nonsense rather than fail loudly on its own.
 */
export function recordRound(state: RoundState, events: readonly GameEvent[]): RoundRecording {
  if (state.phase !== 'betting') {
    throw new Error(`recordRound: expected the betting phase, got "${state.phase}"`);
  }
  if (state.seats.some((seat) => seat.hands.length > 0)) {
    throw new Error('recordRound: bets are already placed; snapshot the state before placeBets()');
  }

  const decisions: RecordedDecision[] = [];
  const hasBet = new Set<number>();

  for (const event of events) {
    switch (event.type) {
      case 'BetPlaced':
        if (hasBet.has(event.seat)) {
          throw new Error(
            `recordRound: seat ${event.seat} bet twice — the events span more than one round`,
          );
        }
        hasBet.add(event.seat);
        decisions.push({ kind: 'bet', seat: event.seat, amount: event.amount });
        break;
      case 'InsuranceTaken':
        decisions.push({ kind: 'insurance', seat: event.seat, take: true });
        break;
      case 'InsuranceDeclined':
        decisions.push({ kind: 'insurance', seat: event.seat, take: false });
        break;
      case 'PlayerActed':
        decisions.push({
          kind: 'action',
          seat: event.ref.seat,
          handIndex: event.ref.handIndex,
          action: event.action,
        });
        break;
      default:
        break;
    }
  }

  return { state, roundNumber: state.roundNumber, decisions };
}

// --- Replay ----------------------------------------------------------------

/** Seats to play under a different policy than they actually did. */
export type PolicyOverrides = ReadonlyMap<number, BotPolicy>;

/**
 * Replay a recorded round, optionally substituting a policy for some seats.
 *
 * With no overrides this reproduces the original round exactly — the property
 * the whole demo rests on, and the first thing the tests assert. Bets always
 * come from the recording, even for an overridden seat: changing the stake
 * would move money for a reason that has nothing to do with how the hand was
 * played, and the comparison is about play.
 */
export function replayRound(recording: RoundRecording, overrides: PolicyOverrides): StepResult {
  const deciders = new Map<number, SeatDecider>();
  for (const seat of recording.state.seats) {
    if (!isOccupied(seat)) continue;
    const override = overrides.get(seat.index);
    deciders.set(
      seat.index,
      override === undefined
        ? scriptedDecider(recording, seat.index)
        : overriddenDecider(recording, seat.index, override),
    );
  }
  const result = playRound(recording.state, deciders);
  return { state: result.state, events: result.events };
}

/**
 * Replays one seat exactly as recorded.
 *
 * The script is consumed in order and abandoned the moment it stops fitting —
 * a recorded action that is no longer legal, or one belonging to a different
 * hand, means the cards have diverged and every later entry describes a hand
 * that no longer exists. Once abandoned it is never resumed, because a script
 * that is right again by coincidence is worse than one that is honestly gone.
 *
 * After divergence the seat plays basic strategy. That is a choice, and it is
 * the defensible one: we cannot know what a human would have done with cards
 * they never saw, and the book answer is the only assumption the app is
 * entitled to make about a player it is teaching.
 *
 * The returned decider is stateful — it holds a cursor. It is built fresh on
 * every `replayRound` call and never escapes it, so replay stays a pure
 * function of its arguments.
 */
function scriptedDecider(recording: RoundRecording, seatIndex: number): SeatDecider {
  const script = recording.decisions.filter(
    (decision): decision is Extract<RecordedDecision, { kind: 'action' }> =>
      decision.kind === 'action' && decision.seat === seatIndex,
  );
  let cursor = 0;
  let diverged = false;

  return {
    bet: () => recordedBet(recording, seatIndex),
    takeInsurance: () => recordedInsurance(recording, seatIndex) ?? false,
    act: (view: ActionView): Action => {
      if (!diverged) {
        const scripted = script[cursor];
        if (
          scripted !== undefined &&
          scripted.handIndex === view.handIndex &&
          view.legalActions.includes(scripted.action)
        ) {
          cursor++;
          return scripted.action;
        }
        diverged = true;
      }
      return decideAction(PERFECT_POLICY, view);
    },
  };
}

/** Replays one seat under a substituted policy, but with its recorded stake. */
function overriddenDecider(
  recording: RoundRecording,
  seatIndex: number,
  policy: BotPolicy,
): SeatDecider {
  const bettor = flatBettor(policy, recordedBet(recording, seatIndex));
  return {
    bet: (view: BetView) => bettor.bet(view),
    takeInsurance: (view: InsuranceView) => policy.takeInsurance(view),
    act: (view: ActionView) => decideAction(policy, view),
  };
}

function recordedBet(recording: RoundRecording, seatIndex: number): number {
  for (const decision of recording.decisions) {
    if (decision.kind === 'bet' && decision.seat === seatIndex) return decision.amount;
  }
  return 0;
}

function recordedInsurance(recording: RoundRecording, seatIndex: number): boolean | undefined {
  for (const decision of recording.decisions) {
    if (decision.kind === 'insurance' && decision.seat === seatIndex) return decision.take;
  }
  return undefined;
}

// --- Reading a seat's result out of an event stream ------------------------

export type SettledHand = {
  readonly handIndex: number;
  readonly outcome: HandOutcome;
  readonly bet: number;
  readonly net: number;
};

export type SeatResult = {
  readonly seat: number;
  /** Profit for the round, insurance included. Negative is a loss. */
  readonly net: number;
  readonly hands: readonly SettledHand[];
  /** Signed insurance result, 0 when none was taken. */
  readonly insuranceNet: number;
};

/** Total one seat's round out of an event stream. */
export function seatResult(events: readonly GameEvent[], seatIndex: number): SeatResult {
  const hands: SettledHand[] = [];
  let net = 0;
  let insuranceNet = 0;

  for (const event of events) {
    if (event.type === 'HandSettled' && event.ref.seat === seatIndex) {
      hands.push({
        handIndex: event.ref.handIndex,
        outcome: event.outcome,
        bet: event.bet,
        net: event.net,
      });
      net += event.net;
    } else if (event.type === 'InsuranceSettled' && event.seat === seatIndex) {
      insuranceNet += event.net;
      net += event.net;
    }
  }

  return { seat: seatIndex, net, hands, insuranceNet };
}

// --- The demo itself -------------------------------------------------------

/**
 * Did the bad player's play help you, hurt you, or change nothing?
 *
 * Stated from the *observed* seat's point of view, which is always the human's.
 * `delta` is what the corrected round would have paid minus what the real round
 * did pay, so a positive delta means playing correctly would have made you
 * money — i.e. the jerk **hurt** you. That sign is easy to get backwards, which
 * is why it is named rather than left to the caller.
 */
export type CounterfactualVerdict = 'helped' | 'hurt' | 'unchanged';

export type Counterfactual = {
  /** The seat replayed under a different policy — the jerk. */
  readonly correctedSeat: number;
  /** The seat whose money is being compared — the human player. */
  readonly observedSeat: number;
  readonly actual: SeatResult;
  readonly corrected: SeatResult;
  /** `corrected.net − actual.net`. */
  readonly delta: number;
  readonly verdict: CounterfactualVerdict;
  /** The replayed round's events, so the UI can show the alternate hand. */
  readonly events: readonly GameEvent[];
};

export type CounterfactualOptions = {
  readonly correctedSeat: number;
  readonly observedSeat: number;
  /** What the corrected seat plays instead. Defaults to perfect basic strategy. */
  readonly policy?: BotPolicy;
};

/**
 * Money is settled in halves of a bet, so any real difference is at least
 * $2.50 at the table minimum. This only guards against floating-point dust.
 */
const NO_DIFFERENCE = 1e-9;

export function counterfactual(
  recording: RoundRecording,
  actualEvents: readonly GameEvent[],
  options: CounterfactualOptions,
): Counterfactual {
  const { correctedSeat, observedSeat } = options;
  if (correctedSeat === observedSeat) {
    throw new Error(
      'counterfactual: the corrected seat and the observed seat are the same — ' +
        'replaying your own hand correctly answers a different question',
    );
  }

  const policy = options.policy ?? PERFECT_POLICY;
  const replayed = replayRound(recording, new Map([[correctedSeat, policy]]));

  const actual = seatResult(actualEvents, observedSeat);
  const corrected = seatResult(replayed.events, observedSeat);
  const delta = corrected.net - actual.net;

  return {
    correctedSeat,
    observedSeat,
    actual,
    corrected,
    delta,
    verdict:
      Math.abs(delta) <= NO_DIFFERENCE ? 'unchanged' : delta > 0 ? 'hurt' : 'helped',
    events: replayed.events,
  };
}

// --- Session tally ---------------------------------------------------------

/**
 * How often the bad player actually helped versus hurt (SPEC §7, §9).
 *
 * Over a session this converges on roughly even, which is the whole lesson.
 * `netDelta` is kept alongside the counts because the counts alone can mislead:
 * many small helps and a few large hurts are a real pattern, and reporting only
 * "helped 12, hurt 11" would hide it.
 */
export type JerkTally = {
  readonly helped: number;
  readonly hurt: number;
  readonly unchanged: number;
  /** Summed `delta`. Positive means the jerk cost you money on balance. */
  readonly netDelta: number;
};

export const EMPTY_JERK_TALLY: JerkTally = { helped: 0, hurt: 0, unchanged: 0, netDelta: 0 };

export function addToTally(tally: JerkTally, result: Counterfactual): JerkTally {
  return {
    helped: tally.helped + (result.verdict === 'helped' ? 1 : 0),
    hurt: tally.hurt + (result.verdict === 'hurt' ? 1 : 0),
    unchanged: tally.unchanged + (result.verdict === 'unchanged' ? 1 : 0),
    netDelta: tally.netDelta + result.delta,
  };
}
