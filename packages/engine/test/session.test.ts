import { describe, expect, it } from 'vitest';

import {
  advanceUntilPlayer,
  counterfactual,
  createGame,
  createSession,
  eventsOfType,
  flatBettor,
  JERK_POLICIES,
  PERFECT_POLICY,
  playRounds,
  policyById,
  replayRound,
  submitAction,
  submitBet,
  submitInsurance,
  VEGAS_STRIP,
  type Action,
  type BotPolicy,
  type Deciders,
  type GameEvent,
  type PlayerPrompt,
  type RoundRecording,
  type RoundState,
  type SeatConfig,
  type SeatDecider,
  type Session,
  type SessionStep,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

const BANKROLL = 10_000_000;
const BET = 500;

type SeatSpec = 'player' | 'empty' | BotPolicy;

/**
 * `playerBankroll` is the player's alone — bots always keep a bankroll deep
 * enough never to bind, so a test about the player running short does not also
 * silently break the table (M2 decision 11).
 */
function game(seed: number, specs: readonly SeatSpec[], playerBankroll = BANKROLL): RoundState {
  const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => {
    const spec = specs[i] ?? 'empty';
    if (spec === 'empty') return { occupant: { kind: 'empty' } as const, bankroll: 0 };
    if (spec === 'player') {
      return { occupant: { kind: 'player' } as const, bankroll: playerBankroll };
    }
    return {
      occupant: { kind: 'bot', policyId: spec.id, characterId: `c${i}` } as const,
      bankroll: BANKROLL,
    };
  });
  return createGame({ rules: VEGAS_STRIP, seed, seats });
}

/** Bot deciders for every bot seat in `specs`, at a flat stake. */
function botDeciders(specs: readonly SeatSpec[], bet = BET): Deciders {
  const entries: [number, SeatDecider][] = [];
  specs.forEach((spec, index) => {
    if (spec === 'player' || spec === 'empty') return;
    entries.push([index, flatBettor(spec, bet)]);
  });
  return new Map(entries);
}

function playerSeatOf(specs: readonly SeatSpec[]): number {
  const index = specs.indexOf('player');
  if (index < 0) throw new Error('specs has no player seat');
  return index;
}

type Drive = {
  readonly session: Session;
  readonly events: readonly GameEvent[];
  readonly prompts: readonly PlayerPrompt[];
  /** Each finished round paired with the state the session held when it finished. */
  readonly finished: readonly { recording: RoundRecording; stateAfter: RoundState }[];
  /** The session as it stood at each prompt — for asserting in-flight invariants. */
  readonly atPrompt: readonly Session[];
};

/**
 * Drive a session with `player` answering the human seat, until the bet prompt
 * for round `rounds + 1`. That stopping point matches `playRounds`, whose
 * postcondition is the betting phase of the round after the last one played.
 */
function drive(
  start: RoundState,
  player: SeatDecider,
  bots: Deciders,
  rounds: number,
): Drive {
  let step = advanceUntilPlayer(createSession(start), bots);
  const events: GameEvent[] = [...step.events];
  const prompts: PlayerPrompt[] = [step.prompt];
  const finished: { recording: RoundRecording; stateAfter: RoundState }[] = [];
  const atPrompt: Session[] = [step.session];

  const harvest = (result: SessionStep): void => {
    for (const recording of result.completedRounds) {
      finished.push({ recording, stateAfter: result.session.state });
    }
  };
  harvest(step);

  let guard = 0;
  for (;;) {
    if (++guard > 100_000) throw new Error('drive: session never finished');
    const session = step.session;
    const prompt = step.prompt;

    if (prompt.kind === 'bet') {
      if (session.state.roundNumber > rounds) break;
      step = submitBet(session, player.bet(prompt.view), bots);
    } else if (prompt.kind === 'insurance') {
      step = submitInsurance(session, player.takeInsurance(prompt.view), bots);
    } else {
      step = submitAction(session, player.act(prompt.view), bots);
    }

    events.push(...step.events);
    prompts.push(step.prompt);
    atPrompt.push(step.session);
    harvest(step);
  }

  return { session: step.session, events, prompts, finished, atPrompt };
}

// --- Construction ----------------------------------------------------------

describe('createSession', () => {
  it('takes the player seat from the table', () => {
    const session = createSession(game(1, ['empty', 'player', PERFECT_POLICY]));
    expect(session.playerSeat).toBe(1);
    expect(session.roundStart).toBeNull();
    expect(session.roundEvents).toEqual([]);
  });

  it('rejects a table with no player', () => {
    expect(() => createSession(game(1, [PERFECT_POLICY, PERFECT_POLICY]))).toThrow(
      /exactly one player seat, got 0/,
    );
  });

  it('rejects a table with two players', () => {
    expect(() => createSession(game(1, ['player', 'player']))).toThrow(
      /exactly one player seat, got 2/,
    );
  });
});

// --- Prompts ---------------------------------------------------------------

describe('advanceUntilPlayer', () => {
  it('opens the first round and stops for a bet', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY];
    const step = advanceUntilPlayer(createSession(game(7, specs)), botDeciders(specs));

    expect(step.prompt.kind).toBe('bet');
    expect(step.session.state.roundNumber).toBe(1);
    expect(step.session.state.phase).toBe('betting');
    expect(eventsOfType(step.events, 'RoundStarted')).toHaveLength(1);
    expect(step.completedRounds).toEqual([]);
  });

  it('bounds the bet by the table limits and the bankroll', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY];
    const rich = advanceUntilPlayer(createSession(game(7, specs)), botDeciders(specs)).prompt;
    const poor = advanceUntilPlayer(
      createSession(game(7, specs, 4200)),
      botDeciders(specs),
    ).prompt;

    expect(rich).toMatchObject({ kind: 'bet', min: VEGAS_STRIP.minBet, max: VEGAS_STRIP.maxBet });
    expect(poor).toMatchObject({ kind: 'bet', min: VEGAS_STRIP.minBet, max: 4200 });
  });

  it('reports a bankroll below the minimum as max < min', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY];
    const prompt = advanceUntilPlayer(createSession(game(7, specs, 300)), botDeciders(specs)).prompt;
    expect(prompt.kind).toBe('bet');
    if (prompt.kind !== 'bet') throw new Error('unreachable');
    expect(prompt.max).toBeLessThan(prompt.min);
  });

  it('never prompts the player about another seat', () => {
    const specs: SeatSpec[] = [PERFECT_POLICY, 'player', policyById('mimics-dealer')];
    const seat = playerSeatOf(specs);
    const result = drive(game(11, specs), flatBettor(PERFECT_POLICY, BET), botDeciders(specs), 40);

    expect(result.prompts.length).toBeGreaterThan(40);
    for (const prompt of result.prompts) {
      if (prompt.kind === 'bet') expect(prompt.view.seat.index).toBe(seat);
      else if (prompt.kind === 'insurance') expect(prompt.view.seat.index).toBe(seat);
      else expect(prompt.view.seat.index).toBe(seat);
    }
  });

  it('offers insurance with the stake already resolved', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY];
    const result = drive(game(3, specs), flatBettor(PERFECT_POLICY, BET), botDeciders(specs), 60);
    const offers = result.prompts.filter((prompt) => prompt.kind === 'insurance');

    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      if (offer.kind !== 'insurance') throw new Error('unreachable');
      expect(offer.stake).toBe(offer.view.seat.baseBet / 2);
      expect(offer.view.table.dealerUpcard.rank).toBe('A');
    }
  });

  it('requires a decider for every bot seat', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY, PERFECT_POLICY];
    const partial: Deciders = new Map([[1, flatBettor(PERFECT_POLICY, BET)]]);
    expect(() => advanceUntilPlayer(createSession(game(1, specs)), partial)).toThrow(
      /no decider for occupied seat\(s\) 2/,
    );
  });
});

// --- Equivalence with playRounds -------------------------------------------

/**
 * The load-bearing test. A session driven by a decider must produce exactly the
 * state and the event stream `playRounds` produces from the same seed with the
 * same decider in the player's seat.
 *
 * This is what says `session.ts` adds no game logic. Every card, every payout
 * and every ordering is decided by `round.ts` in both runs; if the session ever
 * starts answering something itself, reorders a seat, or drops an event, the
 * two streams part company here.
 *
 * The player plays `PERFECT_POLICY`, which never insures — deliberately, since
 * that is the one place the two drivers are documented to differ: `play.ts`
 * collapses an unaffordable insurance wish to a decline and `submitInsurance`
 * does not.
 */
describe('a session matches playRounds exactly', () => {
  const tables: readonly { name: string; specs: SeatSpec[] }[] = [
    { name: 'heads up', specs: ['player'] },
    { name: 'player at first base', specs: ['player', PERFECT_POLICY, PERFECT_POLICY] },
    {
      name: 'player at third base behind a jerk',
      specs: [policyById('mimics-dealer'), PERFECT_POLICY, 'player'],
    },
    {
      name: 'a full table',
      specs: [
        PERFECT_POLICY,
        policyById('hits-every-16'),
        'player',
        policyById('never-splits'),
        policyById('always-insures'),
        policyById('doubles-twelve'),
        policyById('stands-on-soft-17'),
      ],
    },
  ];

  for (const { name, specs } of tables) {
    it(name, () => {
      const seat = playerSeatOf(specs);
      const player = flatBettor(PERFECT_POLICY, BET);
      const bots = botDeciders(specs);
      const all: Deciders = new Map([...bots, [seat, player]]);

      for (const seed of [1, 2026, 987_654]) {
        const start = game(seed, specs);
        const expected = playRounds(start, all, 30);
        const actual = drive(start, player, bots, 30);

        expect(actual.events).toEqual(expected.events);
        expect(actual.session.state).toEqual(expected.state);
      }
    });
  }

  it('holds when the player deviates from the book', () => {
    const specs: SeatSpec[] = ['player', policyById('hits-every-16')];
    // A stubborn player who stands on everything and never insures. The point
    // is that the two drivers agree on a *bad* line as exactly as on a good
    // one — the engine has no opinion about correctness (M1 decision 7).
    const stubborn: SeatDecider = {
      bet: () => BET,
      takeInsurance: () => false,
      act: (view) => (view.legalActions.includes('stand') ? 'stand' : 'hit'),
    };
    const bots = botDeciders(specs);
    const all: Deciders = new Map([...bots, [0, stubborn]]);

    const start = game(555, specs);
    const expected = playRounds(start, all, 30);
    const actual = drive(start, stubborn, bots, 30);

    expect(actual.events).toEqual(expected.events);
    expect(actual.session.state).toEqual(expected.state);
  });
});

// --- Recording -------------------------------------------------------------

describe('round recording', () => {
  const specs: SeatSpec[] = [policyById('mimics-dealer'), 'player'];

  it('produces one recording per finished round, in order', () => {
    const result = drive(game(42, specs), flatBettor(PERFECT_POLICY, BET), botDeciders(specs), 25);

    expect(result.finished).toHaveLength(25);
    result.finished.forEach(({ recording }, i) => {
      expect(recording.roundNumber).toBe(i + 1);
      expect(recording.state.phase).toBe('betting');
      expect(recording.state.seats.every((s) => s.hands.length === 0)).toBe(true);
    });
  });

  /**
   * The in-flight recording must hold the events of *its own* round and no
   * others. The boundary is the only place that can go wrong, and it turns on
   * one ordering: `advanceToPrompt` closes the finished round *before* filing
   * the step's events, because the `idle -> betting` step that ends round N
   * emits `RoundStarted(N+1)`, which belongs to N+1.
   *
   * That ordering is otherwise unfalsifiable. `recordRound` switches on the
   * four decision events and discards everything else, so a `RoundStarted`
   * filed against the wrong round changes no recording and breaks no test —
   * the same shape of invisibility as decision 21, where a number that was
   * never asserted sat wrong for the life of the project. So it is asserted
   * here directly, on `roundEvents`, rather than left to a comment.
   */
  it('files each round-start marker against the round it opens', () => {
    const result = drive(game(42, specs), flatBettor(PERFECT_POLICY, BET), botDeciders(specs), 25);

    expect(result.atPrompt.length).toBeGreaterThan(25);
    for (const session of result.atPrompt) {
      const started = eventsOfType(session.roundEvents, 'RoundStarted');
      expect(started).toHaveLength(1);
      expect(session.roundEvents[0]).toBe(started[0]);
      expect(started[0]?.roundNumber).toBe(session.state.roundNumber);
      expect(session.roundStart?.roundNumber).toBe(session.state.roundNumber);
    }
  });

  it('records a round that replays back to the same state', () => {
    const result = drive(game(42, specs), flatBettor(PERFECT_POLICY, BET), botDeciders(specs), 25);

    for (const { recording, stateAfter } of result.finished) {
      expect(replayRound(recording, new Map()).state).toEqual(stateAfter);
    }
  });

  it('feeds the third-base counterfactual', () => {
    // 120 rounds, not 25: SPEC §7 measured the jerk changing the player's
    // outcome in only ~9% of rounds, so a short run has a real chance of
    // containing none at all and would fail for the wrong reason.
    const result = drive(game(42, specs), flatBettor(PERFECT_POLICY, BET), botDeciders(specs), 120);
    const verdicts = result.finished.map(({ recording }) =>
      counterfactual(recording, replayRound(recording, new Map()).events, {
        correctedSeat: 0,
        observedSeat: 1,
      }).verdict,
    );

    // SPEC §7: the jerk moves the player's outcome only sometimes, and the app
    // needs both directions to be reachable for the prompt to mean anything.
    expect(verdicts).toContain('unchanged');
    expect(verdicts.some((v) => v === 'helped' || v === 'hurt')).toBe(true);
  });
});

// --- Sitting out and rejecting nonsense ------------------------------------

describe('the player at the edges', () => {
  it('sits a round out on a bet of 0', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY];
    const bots = botDeciders(specs);
    const first = advanceUntilPlayer(createSession(game(9, specs)), bots);
    const next = submitBet(first.session, 0, bots);

    expect(eventsOfType(next.events, 'BetPlaced').map((e) => e.seat)).toEqual([1]);
    expect(next.completedRounds).toHaveLength(1);
    expect(next.prompt.kind).toBe('bet');
    expect(next.session.state.roundNumber).toBe(2);
  });

  it('refuses a bet nobody at the table can cover', () => {
    const specs: SeatSpec[] = ['player'];
    const first = advanceUntilPlayer(createSession(game(9, specs)), new Map());
    expect(() => submitBet(first.session, 0, new Map())).toThrow(/At least one seat must bet/);
  });

  it('rejects an illegal action', () => {
    const specs: SeatSpec[] = ['player', PERFECT_POLICY];
    const bots = botDeciders(specs);
    const step = submitBet(
      advanceUntilPlayer(createSession(game(9, specs)), bots).session,
      BET,
      bots,
    );
    expect(step.prompt.kind).toBe('action');
    if (step.prompt.kind !== 'action') throw new Error('unreachable');

    const legal = step.prompt.view.legalActions;
    const illegal = (['split', 'double', 'surrender', 'hit', 'stand'] as Action[]).find(
      (action) => !legal.includes(action),
    );
    if (illegal === undefined) throw new Error('every action was legal');
    expect(() => submitAction(step.session, illegal, bots)).toThrow(/Illegal action/);
  });

  it('rejects insurance the player cannot cover', () => {
    // Bankroll of exactly one bet: the wager is affordable, the insurance is
    // not. `submitInsurance` does not quietly decline it (unlike a bot's wish);
    // offering it was the caller's mistake and it is named as one.
    // Seed 2 shows an ace on the first round. A bankroll of $7 covers the $5
    // wager and leaves $2 against a $2.50 insurance stake.
    const specs: SeatSpec[] = ['player', PERFECT_POLICY];
    const bots = botDeciders(specs);
    const opened = advanceUntilPlayer(createSession(game(2, specs, 700)), bots);
    const step = submitBet(opened.session, BET, bots);

    expect(step.prompt).toMatchObject({ kind: 'insurance', stake: 250 });
    expect(() => submitInsurance(step.session, true, bots)).toThrow(/cannot afford/);
    // Declining is always available, and the round carries on.
    expect(submitInsurance(step.session, false, bots).session.state.phase).not.toBe(
      'insuranceOffer',
    );
  });
});

// --- Serialisability -------------------------------------------------------

it('a session is plain data that survives a round trip', () => {
  const specs: SeatSpec[] = ['player', policyById('never-splits')];
  const bots = botDeciders(specs);
  const step = submitBet(
    advanceUntilPlayer(createSession(game(77, specs)), bots).session,
    BET,
    bots,
  );

  // SPEC §9 persists the session locally; deciders are passed in rather than
  // stored precisely so this holds.
  const revived = JSON.parse(JSON.stringify(step.session)) as Session;
  expect(revived).toEqual(step.session);
  expect(advanceUntilPlayer(revived, bots).prompt).toEqual(
    advanceUntilPlayer(step.session, bots).prompt,
  );
});

it('every jerk personality can be seated without changing the loop', () => {
  for (const policy of JERK_POLICIES) {
    const specs: SeatSpec[] = ['player', policy];
    const result = drive(game(31, specs), flatBettor(PERFECT_POLICY, BET), botDeciders(specs), 10);
    expect(result.finished).toHaveLength(10);
    expect(result.session.state.roundNumber).toBe(11);
  }
});
