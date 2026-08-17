import { describe, expect, it } from 'vitest';

import {
  actionView,
  advanceUntilPlayer,
  assess,
  coach,
  coachAction,
  coachInsurance,
  COUNTING,
  createGame,
  createSession,
  dealerHoleCard,
  evaluateActions,
  explain,
  explainInsurance,
  flatBettor,
  handTotal,
  insuranceEv,
  PERFECT_POLICY,
  PURE_PLAY,
  recommend,
  recommendInsurance,
  seatAt,
  submitAction,
  submitBet,
  submitInsurance,
  unseenComposition,
  VEGAS_STRIP,
  type Action,
  type ActionCoaching,
  type Card,
  type CoachSettings,
  type Deciders,
  type EvInput,
  type InsuranceCoaching,
  type PlayerPrompt,
  type RoundState,
  type SeatConfig,
  type SeatDecider,
  type SessionStep,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

const BANKROLL = 10_000_000;
const BET = 1000;

type SeatSpec = 'player' | 'empty' | 'bot';
type ActionPrompt = Extract<PlayerPrompt, { kind: 'action' }>;

function game(seed: number, specs: readonly SeatSpec[]): RoundState {
  const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => {
    const spec = specs[i] ?? 'empty';
    if (spec === 'empty') return { occupant: { kind: 'empty' } as const, bankroll: 0 };
    if (spec === 'player') return { occupant: { kind: 'player' } as const, bankroll: BANKROLL };
    return {
      occupant: { kind: 'bot', policyId: PERFECT_POLICY.id, characterId: `c${i}` } as const,
      bankroll: BANKROLL,
    };
  });
  return createGame({ rules: VEGAS_STRIP, seed, seats });
}

function botDeciders(specs: readonly SeatSpec[]): Deciders {
  const entries: [number, SeatDecider][] = [];
  specs.forEach((spec, index) => {
    if (spec === 'bot') entries.push([index, flatBettor(PERFECT_POLICY, BET)]);
  });
  return new Map(entries);
}

/** The session as it stood when the player was asked something. */
type Stop = {
  readonly state: RoundState;
  readonly seat: number;
  readonly prompt: PlayerPrompt;
  readonly step: SessionStep;
};

/**
 * Drive a table with the player following the book, calling `visit` at every
 * prompt. The player plays perfectly because these tests are about the coaching
 * and not about the line — a deviating player would reach different hands as
 * soon as the chart changed, which is exactly the coupling to avoid.
 */
function eachPrompt(
  seed: number,
  specs: readonly SeatSpec[],
  rounds: number,
  visit: (stop: Stop) => void,
): void {
  const bots = botDeciders(specs);
  const player = flatBettor(PERFECT_POLICY, BET);
  let step = advanceUntilPlayer(createSession(game(seed, specs)), bots);
  const seat = step.session.playerSeat;

  for (let guard = 0; guard < 200_000; guard++) {
    const { session, prompt } = step;
    visit({ state: session.state, seat, prompt, step });

    if (prompt.kind === 'bet') {
      if (session.state.roundNumber > rounds) return;
      step = submitBet(session, player.bet(prompt.view), bots);
    } else if (prompt.kind === 'insurance') {
      step = submitInsurance(session, player.takeInsurance(prompt.view), bots);
    } else {
      step = submitAction(session, player.act(prompt.view), bots);
    }
  }
  throw new Error('eachPrompt: session never finished');
}

/** Every object reachable from `root`, for the hole-card leak check. */
function reachable(root: unknown): Set<object> {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...Object.values(node));
  }
  return seen;
}

const isTenOrAce = (card: Card): boolean => card.rank === 'A' || handTotal([card]).total === 10;

/** EV of one action, insisting it was available. */
function evOf(coaching: ActionCoaching, action: Action): number {
  const { ev } = coaching;
  if (action === 'stand') return ev.stand;
  if (action === 'hit') return ev.hit;
  const value = action === 'double' ? ev.double : action === 'split' ? ev.split : null;
  if (value === null) throw new Error(`evOf: ${action} is not priced on this hand`);
  return value;
}

/** Every action prompt in `seed` satisfying `want`, coached under Pure Play. */
function findActions(
  seed: number,
  rounds: number,
  want: (coaching: ActionCoaching, prompt: ActionPrompt) => boolean,
): { coaching: ActionCoaching; prompt: ActionPrompt }[] {
  const hits: { coaching: ActionCoaching; prompt: ActionPrompt }[] = [];
  eachPrompt(seed, ['player', 'bot'], rounds, ({ state, seat, prompt }) => {
    if (prompt.kind !== 'action' || hits.length > 0) return;
    const coaching = coachAction(state, seat, PURE_PLAY);
    if (want(coaching, prompt)) hits.push({ coaching, prompt });
  });
  return hits;
}

function findAction(
  seed: number,
  rounds: number,
  want: (coaching: ActionCoaching, prompt: ActionPrompt) => boolean,
): { coaching: ActionCoaching; prompt: ActionPrompt } {
  const hit = findActions(seed, rounds, want)[0];
  if (hit === undefined) throw new Error('findAction: no matching prompt in this session');
  return hit;
}

// --- The facade adds nothing -----------------------------------------------

describe('coachAction', () => {
  /**
   * The load-bearing test, and the reason this module may exist as a facade
   * rather than as documentation telling callers what order to use. It
   * hand-wires the same four calls a screen would have had to make and requires
   * the results to be identical. If `coach.ts` ever computes, rounds or decides
   * anything of its own, this breaks.
   */
  it('is exactly unseenComposition -> recommend -> evaluateActions -> explain', () => {
    let checked = 0;
    for (const settings of [PURE_PLAY, COUNTING] as CoachSettings[]) {
      eachPrompt(31, ['player', 'bot', 'bot'], 12, ({ state, seat, prompt }) => {
        if (prompt.kind !== 'action') return;
        const coaching = coachAction(state, seat, settings);

        const view = actionView(state, seat);
        const recommendation = recommend(view.hand, view.table.dealerUpcard, view.context);
        const evInput: EvInput = {
          rules: state.rules,
          composition: unseenComposition(state, settings.knownCards),
          playerCards: view.hand.cards,
          dealerUpcard: view.table.dealerUpcard,
          fromSplit: view.hand.fromSplit,
          canDouble: view.legalActions.includes('double'),
          canSplit: view.legalActions.includes('split'),
          peekedNotBlackjack: state.rules.dealerPeeks && isTenOrAce(view.table.dealerUpcard),
        };
        const ev = evaluateActions(evInput);

        expect(coaching.recommendation).toEqual(recommendation);
        expect(coaching.ev).toEqual(ev);
        expect(coaching.evInput).toEqual(evInput);
        expect(coaching.explanation).toEqual(explain({ evInput, ev, recommendation }));
        expect(coaching.stake).toBe(view.hand.bet);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('recommends an action the hand may actually take', () => {
    let checked = 0;
    eachPrompt(77, ['player', 'bot'], 20, ({ state, seat, prompt }) => {
      if (prompt.kind !== 'action') return;
      const coaching = coachAction(state, seat, PURE_PLAY);
      expect(prompt.view.legalActions).toContain(coaching.recommendation.action);
      checked++;
    });
    expect(checked).toBeGreaterThan(15);
  });

  it('refuses to advise a seat that is not acting', () => {
    expect(() => coachAction(game(5, ['player', 'bot']), 0, PURE_PLAY)).toThrow(/not acting/);
  });
});

// --- What the coach is allowed to know -------------------------------------

describe('the peek condition', () => {
  /**
   * `peekedNotBlackjack` is derived from the shape of the round rather than read
   * from `dealer.hasBlackjack`, the one field `view.ts` exists to hide. This is
   * the claim that derivation rests on: a dealer holding a natural settles the
   * round at the peek, so no seat is ever asked to act against one. Cheap to run
   * wide, because it touches no EV.
   */
  it('never asks a seat to act against a dealer natural', () => {
    let peekable = 0;
    eachPrompt(101, ['player', 'bot', 'bot'], 300, ({ state, prompt }) => {
      if (prompt.kind !== 'action') return;
      if (!isTenOrAce(prompt.view.table.dealerUpcard)) return;
      expect(state.dealer.hasBlackjack).toBe(false);
      peekable++;
    });
    expect(peekable).toBeGreaterThan(100);
  });

  it('sets the flag exactly on the upcards the dealer peeks at', () => {
    let peeked = 0;
    let unpeeked = 0;
    eachPrompt(202, ['player', 'bot'], 40, ({ state, seat, prompt }) => {
      if (prompt.kind !== 'action') return;
      const { evInput } = coachAction(state, seat, PURE_PLAY);
      expect(evInput.peekedNotBlackjack).toBe(isTenOrAce(evInput.dealerUpcard));
      if (evInput.peekedNotBlackjack) peeked++;
      else unpeeked++;
    });
    expect(peeked).toBeGreaterThan(5);
    expect(unpeeked).toBeGreaterThan(5);
  });

  it('never lets the hole card reach the coaching it hands the player', () => {
    let facedown = 0;
    eachPrompt(303, ['player', 'bot', 'bot'], 20, ({ state, seat, prompt }) => {
      if (prompt.kind !== 'action' || state.dealer.holeCardRevealed) return;
      const hole = dealerHoleCard(state);
      if (hole === undefined) return;
      // Identity, not rank: the hole card's *rank* legitimately appears all over
      // the table, and comparing ranks would fail constantly for no reason.
      for (const settings of [PURE_PLAY, COUNTING] as CoachSettings[]) {
        expect(reachable(coachAction(state, seat, settings)).has(hole)).toBe(false);
      }
      facedown++;
    });
    expect(facedown).toBeGreaterThan(15);
  });
});

describe('knownCards', () => {
  it('agrees with full-shoe on the first round and parts company after it', () => {
    let sameInRoundOne = 0;
    let differentLater = 0;

    eachPrompt(59, ['player', 'bot', 'bot'], 15, ({ state, seat, prompt }) => {
      if (prompt.kind !== 'action') return;
      const pure = coachAction(state, seat, PURE_PLAY).evInput.composition;
      const counting = coachAction(state, seat, COUNTING).evInput.composition;
      const identical = pure.every((count, i) => count === counting[i]);

      // Round one is dealt from a fresh shoe, so "a fresh shoe minus what is
      // face up" and "what is left in the shoe, plus the hole card back" are the
      // same multiset. From round two the discard tray is the difference —
      // precisely the information a counter has and a table-reader does not.
      if (state.roundNumber === 1) {
        expect(identical).toBe(true);
        sameInRoundOne++;
      } else if (!identical) {
        differentLater++;
      }
    });

    expect(sameInRoundOne).toBeGreaterThan(0);
    expect(differentLater).toBeGreaterThan(0);
  });
});

// --- Dispatch --------------------------------------------------------------

describe('coach', () => {
  it('has nothing to say about a bet', () => {
    const specs: SeatSpec[] = ['player', 'bot'];
    const step = advanceUntilPlayer(createSession(game(11, specs)), botDeciders(specs));
    expect(step.prompt.kind).toBe('bet');
    expect(coach(step, PURE_PLAY)).toBeNull();
  });

  it('coaches every action and insurance prompt it is given', () => {
    const kinds = new Set<string>();
    eachPrompt(97, ['player', 'bot', 'bot'], 60, ({ step, prompt }) => {
      const coaching = coach(step, PURE_PLAY);
      if (prompt.kind === 'bet') {
        expect(coaching).toBeNull();
        return;
      }
      expect(coaching?.kind).toBe(prompt.kind);
      kinds.add(prompt.kind);
    });
    expect(kinds.has('action')).toBe(true);
    expect(kinds.has('insurance')).toBe(true);
  });
});

// --- Insurance -------------------------------------------------------------

describe('coachInsurance', () => {
  it('declines, prices the side bet, and quotes the same numbers as the parts', () => {
    let offers = 0;
    eachPrompt(97, ['player', 'bot', 'bot'], 60, ({ state, seat, prompt }) => {
      if (prompt.kind !== 'insurance') return;
      const coaching = coachInsurance(state, seat, prompt.view.cost, PURE_PLAY);
      const composition = unseenComposition(state, 'current-round');

      expect(coaching.take).toBe(recommendInsurance().take);
      expect(coaching.take).toBe(false);
      expect(coaching.ev).toBe(insuranceEv(composition, state.rules));
      expect(coaching.ev).toBeLessThan(0);
      expect(coaching.explanation).toEqual(explainInsurance(composition, state.rules));
      expect(coaching.stake).toBe(prompt.stake);
      expect(coaching.stake).toBe(seatAt(state, seat).baseBet * prompt.view.cost);
      offers++;
    });
    expect(offers).toBeGreaterThan(2);
  });
});

// --- Scoring a decision ----------------------------------------------------

describe('assess', () => {
  it('scores the book answer as exactly free', () => {
    let checked = 0;
    eachPrompt(43, ['player', 'bot'], 25, ({ state, seat, prompt }) => {
      if (prompt.kind !== 'action') return;
      const coaching = coachAction(state, seat, PURE_PLAY);
      const decision = assess(coaching, { kind: 'action', action: coaching.recommendation.action });

      expect(decision.wasRecommended).toBe(true);
      expect(decision.evDelta).toBe(0);
      expect(decision.moneyDelta).toBe(0);
      expect(decision.reasonCode).toBe(coaching.recommendation.reasonCode);
      checked++;
    });
    expect(checked).toBeGreaterThan(20);
  });

  it('prices every legal alternative against the same EV numbers', () => {
    let checked = 0;
    eachPrompt(43, ['player', 'bot'], 25, ({ state, seat, prompt }) => {
      if (prompt.kind !== 'action') return;
      const coaching = coachAction(state, seat, PURE_PLAY);
      const book = coaching.recommendation.action;
      const bookEv = evOf(coaching, book);

      for (const action of prompt.view.legalActions) {
        const decision = assess(coaching, { kind: 'action', action });
        expect(decision.evDelta).toBeCloseTo(evOf(coaching, action) - bookEv, 12);
        expect(decision.moneyDelta).toBeCloseTo(decision.evDelta * coaching.stake, 10);
        expect(decision.wasRecommended).toBe(action === book);
        // Nothing may score above the EV-optimal action, by definition of a max.
        expect(decision.evDelta).toBeLessThanOrEqual(coaching.ev.bestEv - bookEv + 1e-12);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(40);
  });

  /**
   * The sign convention pinned by a case nobody can argue with. Inverting
   * `chosen - recommended` would leave every other assertion in this file
   * passing and would report the app's worst mistakes as its best plays — the
   * same failure mode M3 decision 29 guards for the counterfactual's `delta`.
   */
  it('scores hitting a hard pat hand as a large loss, not a gain', () => {
    const { coaching } = findAction(12345, 200, (c, p) => {
      // Hard, not merely 19 or better: hitting a *soft* 19 cannot bust and is
      // only mildly wrong (about -0.23), which is too quiet a number to pin a
      // sign convention on. A hard 19 or 20 busts on almost every card.
      const total = handTotal(c.evInput.playerCards);
      return (
        c.recommendation.action === 'stand' &&
        p.view.legalActions.includes('hit') &&
        !total.soft &&
        total.total >= 19
      );
    });
    const decision = assess(coaching, { kind: 'action', action: 'hit' });

    expect(decision.wasRecommended).toBe(false);
    expect(decision.evDelta).toBeLessThan(-0.5);
    expect(decision.moneyDelta).toBeCloseTo(decision.evDelta * coaching.stake, 10);
    expect(coaching.stake).toBe(BET);
    expect(decision.moneyDelta).toBeLessThan(-500);
  });

  it('rejects an action the hand could not have taken', () => {
    const { coaching } = findAction(12345, 200, (_, p) => !p.view.legalActions.includes('double'));
    expect(coaching.ev.double).toBeNull();
    expect(() => assess(coaching, { kind: 'action', action: 'double' })).toThrow(
      /double was not available/,
    );
  });

  it('rejects surrender, which no MVP rule set offers', () => {
    const { coaching } = findAction(12345, 5, () => true);
    expect(() => assess(coaching, { kind: 'action', action: 'surrender' })).toThrow(/surrender/);
  });

  it('rejects a choice of the wrong kind', () => {
    const { coaching } = findAction(12345, 5, () => true);
    expect(() => assess(coaching, { kind: 'insurance', take: true })).toThrow(
      /insurance choice against action coaching/,
    );
  });
});

describe('assess, on insurance', () => {
  function anOffer(): InsuranceCoaching {
    const offers: InsuranceCoaching[] = [];
    eachPrompt(97, ['player', 'bot', 'bot'], 60, ({ state, seat, prompt }) => {
      if (offers.length > 0 || prompt.kind !== 'insurance') return;
      offers.push(coachInsurance(state, seat, prompt.view.cost, PURE_PLAY));
    });
    const offer = offers[0];
    if (offer === undefined) throw new Error('anOffer: no insurance offer in this session');
    return offer;
  }

  it('scores declining as exactly free', () => {
    const decision = assess(anOffer(), { kind: 'insurance', take: false });
    expect(decision.wasRecommended).toBe(true);
    expect(decision.evDelta).toBe(0);
    expect(decision.moneyDelta).toBe(0);
    expect(decision.reasonCode).toBe('INSURANCE_IS_A_SUCKER_BET');
  });

  it('scores taking it as a loss, in base-bet units and in money', () => {
    const coaching = anOffer();
    const decision = assess(coaching, { kind: 'insurance', take: true });

    expect(decision.wasRecommended).toBe(false);
    expect(decision.evDelta).toBeCloseTo(coaching.ev * coaching.cost, 12);
    expect(decision.moneyDelta).toBeCloseTo(coaching.ev * coaching.stake, 10);
    expect(decision.moneyDelta).toBeLessThan(0);
    // The stake is half the base bet, so the cost per base bet is half the
    // per-stake number — the unit slip this pair of fields exists to prevent.
    expect(decision.evDelta).toBeCloseTo(decision.moneyDelta / BET, 12);
  });

  it('rejects an action choice against an insurance offer', () => {
    expect(() => assess(anOffer(), { kind: 'action', action: 'hit' })).toThrow(
      /action choice against insurance coaching/,
    );
  });
});
