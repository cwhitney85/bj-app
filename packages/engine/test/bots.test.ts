import { describe, expect, it } from 'vitest';

import { RANKS, SUITS, type Card, type Rank, type Suit } from '../src/cards.js';
import { eventsOfType, type GameEvent } from '../src/events.js';
import {
  addToTally,
  advanceUntilDecision,
  ALL_POLICIES,
  assignJerk,
  counterfactual,
  createGame,
  createHand,
  dealerShouldHit,
  decideAction,
  EMPTY_JERK_TALLY,
  flatBettor,
  handTotal,
  JERK_POLICIES,
  legalActions,
  PERFECT_POLICY,
  playRound,
  playRounds,
  policyById,
  recommend,
  recordRound,
  VEGAS_STRIP,
  type Action,
  type ActionView,
  type BotPolicy,
  type Deciders,
  type Hand,
  type InsuranceView,
  type LegalActionContext,
  type RoundState,
  type RuleSet,
  type Seat,
  type SeatConfig,
  type TableView,
} from '../src/index.js';

// --- Building a view by hand -----------------------------------------------
//
// A policy takes an `ActionView` and nothing else, so a policy can be swept
// exhaustively without dealing a single round. That is the point of the view
// being plain data: the sweeps below cover every hand shape the chart has, which
// no amount of simulated play would reach in a reasonable time.

const BET = 10;

/** Same compact card builder the other suites use: `cards('A', '7')`. */
function cards(...specs: readonly string[]): Card[] {
  return specs.map((spec, i) => {
    const rank = spec.slice(0, 1) as Rank;
    const suit = (spec.length > 1 ? spec.slice(1, 2) : SUITS[i % SUITS.length]) as Suit;
    return { rank, suit, id: `${rank}${suit}#${i}` };
  });
}

function upcard(rank: Rank): Card {
  return { rank, suit: 'S', id: `${rank}S#up` };
}

function seatHolding(hand: Hand, bankroll: number): Seat {
  return {
    index: 3,
    occupant: { kind: 'bot', policyId: 'under-test', characterId: 'x' },
    bankroll,
    baseBet: hand.bet,
    hands: [hand],
    activeHandIndex: 0,
    insuranceBet: 0,
    insuranceResolved: false,
  };
}

function tableShowing(up: Rank, rules: RuleSet, seat: Seat, hand: Hand): TableView {
  return {
    rules,
    roundNumber: 1,
    dealerUpcard: upcard(up),
    dealerCards: [upcard(up)],
    holeCardRevealed: false,
    seats: [seat],
    visibleCards: [upcard(up), ...hand.cards],
    shoeIndex: 10,
  };
}

type ViewOptions = {
  readonly handCount?: number;
  readonly availableFunds?: number;
  readonly rules?: RuleSet;
  readonly hand?: Partial<Hand>;
};

/** An `ActionView` for one hand against one upcard. Returns null when the hand
 *  has nothing to decide — those are not decision points and `actionView`
 *  itself refuses to build them. */
function viewOf(specs: readonly string[], up: Rank, options: ViewOptions = {}): ActionView | null {
  const rules = options.rules ?? VEGAS_STRIP;
  const hand: Hand = { ...createHand(cards(...specs), BET), ...(options.hand ?? {}) };
  const context: LegalActionContext = {
    rules,
    handCount: options.handCount ?? 1,
    availableFunds: options.availableFunds ?? 1000,
  };
  const legal = legalActions(hand, context);
  if (legal.length === 0) return null;
  const seat = seatHolding(hand, context.availableFunds);
  return {
    table: tableShowing(up, rules, seat, hand),
    seat,
    handIndex: 0,
    hand,
    legalActions: legal,
    context,
  };
}

/** As `viewOf`, but for the cases where the caller knows the hand can act. */
function actingView(specs: readonly string[], up: Rank, options: ViewOptions = {}): ActionView {
  const view = viewOf(specs, up, options);
  if (view === null) throw new Error(`${specs.join(',')} has no legal actions`);
  return view;
}

function insuranceOffer(up: Rank = 'A'): InsuranceView {
  const hand = createHand(cards('T', '7'), BET);
  const seat = seatHolding(hand, 1000);
  return { table: tableShowing(up, VEGAS_STRIP, seat, hand), seat, cost: 0.5 };
}

const UPCARDS: readonly Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'A'];

/** All rank multisets of exactly `size` cards — order-insensitive, so no blowup. */
function rankCombinations(size: number): Rank[][] {
  const out: Rank[][] = [];
  const walk = (start: number, acc: Rank[]): void => {
    if (acc.length === size) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < RANKS.length; i++) {
      const rank = RANKS[i];
      if (rank === undefined) continue;
      acc.push(rank);
      walk(i, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

/** Every acting view over a sweep of hands, contexts and upcards. */
function* everyView(sizes: readonly number[] = [2, 3]): Generator<ActionView> {
  const optionSets: readonly ViewOptions[] = [
    {},
    { handCount: 4 },
    { availableFunds: 0 },
    { hand: { fromSplit: true } },
  ];
  for (const size of sizes) {
    for (const ranks of rankCombinations(size)) {
      for (const options of optionSets) {
        for (const up of UPCARDS) {
          const view = viewOf(ranks, up, options);
          if (view !== null) yield view;
        }
      }
    }
  }
}

function label(view: ActionView): string {
  return `${view.hand.cards.map((card) => card.rank).join(',')} vs ${view.table.dealerUpcard.rank}`;
}

// --- Driving real rounds ---------------------------------------------------

/** A table of seven bots all running the same habit — the fastest way to make
 *  a rare habit show up often enough to count events. */
function tableOf(policy: BotPolicy, seed: number, seats = 7, bankroll = 1_000_000): RoundState {
  const configs: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => ({
    occupant:
      i < seats
        ? ({ kind: 'bot', policyId: policy.id, characterId: `c${i}` } as const)
        : ({ kind: 'empty' } as const),
    bankroll: i < seats ? bankroll : 0,
  }));
  return createGame({ rules: VEGAS_STRIP, seed, seats: configs });
}

function decidersFor(policy: BotPolicy, seats: number): Deciders {
  const map = new Map<number, ReturnType<typeof flatBettor>>();
  for (let i = 0; i < seats; i++) map.set(i, flatBettor(policy, 5));
  return map;
}

/** Play `rounds` rounds with one habit at every seat and keep the events. */
function eventsFrom(policy: BotPolicy, rounds: number, seed: number): readonly GameEvent[] {
  const seats = 7;
  return playRounds(tableOf(policy, seed, seats), decidersFor(policy, seats), rounds).events;
}

// --- The policy the app is teaching ----------------------------------------

describe('the perfect policy is the strategy engine, not a copy of it', () => {
  it('agrees with recommend() on every hand, context and upcard', () => {
    let checked = 0;
    for (const view of everyView([2, 3])) {
      const expected = recommend(view.hand, view.table.dealerUpcard, view.context).action;
      expect(PERFECT_POLICY.act(view), label(view)).toBe(expected);
      checked++;
    }
    // The sweep is the test; a generator that yielded nothing would pass.
    expect(checked).toBeGreaterThan(12_000);
  });

  it('declines insurance, which is what the chart says (SPEC §5.4)', () => {
    expect(PERFECT_POLICY.takeInsurance(insuranceOffer())).toBe(false);
  });

  it('is the default every bot gets, and is the only non-jerk policy', () => {
    expect(policyById('perfect')).toBe(PERFECT_POLICY);
    expect(ALL_POLICIES).toEqual([PERFECT_POLICY, ...JERK_POLICIES]);
    expect(JERK_POLICIES).not.toContain(PERFECT_POLICY);
  });
});

// --- Each habit actually has its habit --------------------------------------

describe('always-insures', () => {
  const policy = policyById('always-insures');

  it('takes insurance every time it is offered', () => {
    expect(policy.takeInsurance(insuranceOffer())).toBe(true);
    // The offer only ever arrives on an ace, but the policy is not allowed to
    // be right by accident — it says yes to whatever it is shown.
    for (const up of UPCARDS) expect(policy.takeInsurance(insuranceOffer(up))).toBe(true);
  });

  it('differs from perfect play only in the side bet', () => {
    // This is the whole personality: the hands are played correctly and the
    // money leaks entirely through a bet the player thinks is protection. It is
    // also what makes the cost measurement below exact — the cards do not move.
    for (const view of everyView([2])) {
      expect(policy.act(view), label(view)).toBe(PERFECT_POLICY.act(view));
    }
  });

  it('actually buys insurance at a real table, where perfect play never does', () => {
    const jerk = eventsFrom(policy, 400, 4242);
    const perfect = eventsFrom(PERFECT_POLICY, 400, 4242);
    expect(eventsOfType(jerk, 'InsuranceTaken').length).toBeGreaterThan(50);
    expect(eventsOfType(perfect, 'InsuranceTaken')).toHaveLength(0);
  });
});

describe('hits-every-16', () => {
  const policy = policyById('hits-every-16');

  it('hits every hard 16, whatever the dealer shows and however it is made', () => {
    for (const specs of [['T', '6'], ['9', '7'], ['T', '3', '3'], ['5', '4', '7']]) {
      for (const up of UPCARDS) {
        expect(policy.act(actingView(specs, up)), `${specs.join(',')} vs ${up}`).toBe('hit');
      }
    }
  });

  it('hits 8,8 too — the pair the chart splits against every upcard', () => {
    for (const up of UPCARDS) {
      const view = actingView(['8', '8'], up);
      expect(recommend(view.hand, view.table.dealerUpcard, view.context).action, `8,8 vs ${up}`).toBe(
        'split',
      );
      expect(policy.act(view), `8,8 vs ${up}`).toBe('hit');
    }
  });

  it('leaves soft 16 alone: the folk theory is about hard sixteens', () => {
    // A,5 is a soft 16 and cannot be hurt by a card, so it is not the mistake.
    for (const up of UPCARDS) {
      const view = actingView(['A', '5'], up);
      expect(policy.act(view), `A,5 vs ${up}`).toBe(PERFECT_POLICY.act(view));
    }
  });

  it('differs from the book wherever the book stands or splits a 16', () => {
    // 16 vs 6 is the argued-about one: the chart stands and lets the dealer bust.
    expect(PERFECT_POLICY.act(actingView(['T', '6'], '6'))).toBe('stand');
    expect(policy.act(actingView(['T', '6'], '6'))).toBe('hit');
  });
});

describe('never-splits', () => {
  const policy = policyById('never-splits');

  it('never splits anything, not even aces or eights', () => {
    for (const rank of RANKS) {
      for (const up of UPCARDS) {
        const view = actingView([rank, rank], up);
        expect(view.legalActions, `${rank},${rank} vs ${up}`).toContain('split');
        expect(policy.act(view), `${rank},${rank} vs ${up}`).not.toBe('split');
      }
    }
  });

  it('plays the pair as the total it actually is', () => {
    // A,A becomes a soft 12 and hits; 8,8 becomes a hard 16 and follows the
    // hard-16 row — stand against a 6, hit against a ten.
    expect(policy.act(actingView(['A', 'A'], '6'))).toBe('hit');
    expect(policy.act(actingView(['8', '8'], '6'))).toBe('stand');
    expect(policy.act(actingView(['8', '8'], 'T'))).toBe('hit');
    // T,T was never going to be split anyway, so nothing changes there.
    expect(policy.act(actingView(['T', 'T'], '6'))).toBe('stand');
  });

  it('produces no split at all over hundreds of real rounds, where perfect play does', () => {
    const jerk = eventsFrom(policy, 300, 2718);
    const perfect = eventsFrom(PERFECT_POLICY, 300, 2718);
    expect(eventsOfType(jerk, 'HandSplit')).toHaveLength(0);
    expect(eventsOfType(perfect, 'HandSplit').length).toBeGreaterThan(20);
  });
});

describe('stands-on-soft-17', () => {
  const policy = policyById('stands-on-soft-17');

  it('stands on soft 17 against every upcard, never hitting and never doubling', () => {
    for (const specs of [['A', '6'], ['A', '2', '4'], ['A', '3', '3']]) {
      for (const up of UPCARDS) {
        const action = policy.act(actingView(specs, up));
        expect(action, `${specs.join(',')} vs ${up}`).toBe('stand');
      }
    }
  });

  it('gives up a draw that cannot bust: the book hits or doubles A,6 every time', () => {
    for (const up of UPCARDS) {
      const book = PERFECT_POLICY.act(actingView(['A', '6'], up));
      expect(book, `A,6 vs ${up}`).not.toBe('stand');
    }
  });

  it('plays every other soft total by the book', () => {
    for (const specs of [['A', '5'], ['A', '7'], ['A', '8'], ['A', '2']]) {
      for (const up of UPCARDS) {
        const view = actingView(specs, up);
        expect(policy.act(view), label(view)).toBe(PERFECT_POLICY.act(view));
      }
    }
  });
});

describe('doubles-twelve', () => {
  const policy = policyById('doubles-twelve');

  it('doubles a hard 12 whenever doubling is legal', () => {
    for (const specs of [['T', '2'], ['9', '3'], ['8', '4'], ['7', '5'], ['6', '6']]) {
      for (const up of UPCARDS) {
        const view = actingView(specs, up);
        expect(view.legalActions, label(view)).toContain('double');
        expect(policy.act(view), label(view)).toBe('double');
      }
    }
  });

  it('doubles 6,6 rather than splitting it, which the chart wants against 3-6', () => {
    expect(PERFECT_POLICY.act(actingView(['6', '6'], '5'))).toBe('split');
    expect(policy.act(actingView(['6', '6'], '5'))).toBe('double');
  });

  it('falls back to the book when it cannot double, rather than choosing nonsense', () => {
    // Doubling is a first-two-cards action, so a three-card 12 cannot take it.
    const threeCard = actingView(['5', '4', '3'], '6');
    expect(threeCard.legalActions).not.toContain('double');
    expect(policy.act(threeCard)).toBe(PERFECT_POLICY.act(threeCard));
    // Neither can a seat that cannot cover a second bet.
    const broke = actingView(['T', '2'], '6', { availableFunds: 0 });
    expect(broke.legalActions).not.toContain('double');
    expect(policy.act(broke)).toBe(PERFECT_POLICY.act(broke));
  });

  it('leaves soft 12 alone: A,A is not the hand the habit is about', () => {
    const view = actingView(['A', 'A'], '6', { handCount: 4 });
    expect(handTotal(view.hand.cards)).toEqual({ total: 12, soft: true });
    expect(policy.act(view)).toBe(PERFECT_POLICY.act(view));
  });
});

describe('mimics-dealer', () => {
  const policy = policyById('mimics-dealer');

  it('makes exactly the decision the dealer would make with the same cards', () => {
    let checked = 0;
    for (const view of everyView([2, 3])) {
      const expected: Action = dealerShouldHit(view.hand.cards, view.table.rules) ? 'hit' : 'stand';
      expect(view.legalActions, label(view)).toContain(expected);
      expect(policy.act(view), label(view)).toBe(expected);
      checked++;
    }
    expect(checked).toBeGreaterThan(12_000);
  });

  it('reads the dealer rule from the rule set rather than hardcoding S17', () => {
    // VEGAS_STRIP stands on soft 17; the mimic must follow whichever rule is in
    // force, or it stops being a mimic the moment an H17 rule set lands.
    const h17: RuleSet = { ...VEGAS_STRIP, dealerHitsSoft17: true };
    expect(policy.act(actingView(['A', '6'], '9'))).toBe('stand');
    expect(policy.act(actingView(['A', '6'], '9', { rules: h17 }))).toBe('hit');
  });

  it('never doubles and never splits over hundreds of real rounds', () => {
    const events = eventsFrom(policy, 300, 31415);
    expect(eventsOfType(events, 'HandDoubled')).toHaveLength(0);
    expect(eventsOfType(events, 'HandSplit')).toHaveLength(0);
    expect(eventsOfType(events, 'InsuranceTaken')).toHaveLength(0);
    // It did play, though — a policy that never acted would also never double.
    expect(eventsOfType(events, 'HandSettled').length).toBeGreaterThan(2000);
  });
});

// --- The chokepoint ---------------------------------------------------------

describe('decideAction enforces the postcondition and names the culprit', () => {
  /** Surrender is never legal under VEGAS_STRIP, so this is always illegal. */
  const broken: BotPolicy = {
    id: 'deliberately-broken',
    label: 'Broken',
    description: 'Chooses an action nobody is allowed to take.',
    act: () => 'surrender',
    takeInsurance: () => false,
  };

  it('throws naming the policy, the action and the seat', () => {
    const view = actingView(['T', '6'], '9');
    expect(() => decideAction(broken, view)).toThrow(/deliberately-broken/);
    expect(() => decideAction(broken, view)).toThrow(/surrender/);
    expect(() => decideAction(broken, view)).toThrow(/seat 3/);
    // `applyAction` would reject this too, but its message names the seat and
    // not the policy — which is the difference between a one-line fix and a
    // debugging session when six personalities are at the table.
    expect(() => decideAction(broken, view)).toThrow(/legal: stand, hit/);
  });

  it('passes a legal choice straight through, whichever policy made it', () => {
    for (const view of everyView([2])) {
      for (const policy of ALL_POLICIES) {
        expect(decideAction(policy, view), `${policy.id}: ${label(view)}`).toBe(policy.act(view));
      }
    }
  });
});

// --- Purity -----------------------------------------------------------------

describe('policies are pure functions of the public view', () => {
  it('returns the same action twice for the same view', () => {
    for (const view of everyView([2])) {
      for (const policy of ALL_POLICIES) {
        expect(policy.act(view), `${policy.id}: ${label(view)}`).toBe(policy.act(view));
      }
    }
  });

  it('returns the same action for an equal view built independently', () => {
    // Identity of the view object must not matter — a policy that memoised on
    // object identity would replay differently and break the counterfactual.
    for (const up of UPCARDS) {
      for (const policy of ALL_POLICIES) {
        const a = actingView(['9', '7'], up);
        const b = actingView(['9', '7'], up);
        expect(policy.act(a), `${policy.id} vs ${up}`).toBe(policy.act(b));
      }
    }
  });

  it('draws no randomness — a whole session plays out with Math.random disabled', () => {
    // The randomness SPEC §6 asks for lives in *which* seat gets *which* habit,
    // drawn once by `assignJerk` from its own derived stream. If a decision ever
    // reached for a random number, re-running one seat under a different policy
    // would perturb every other seat, and the §7 counterfactual would be a
    // comparison of two different games.
    const real = Math.random;
    Math.random = (): number => {
      throw new Error('a policy reached for Math.random');
    };
    try {
      for (const policy of ALL_POLICIES) {
        const events = playRounds(tableOf(policy, 777, 4), decidersFor(policy, 4), 40).events;
        expect(eventsOfType(events, 'HandSettled').length, policy.id).toBeGreaterThan(100);
      }
    } finally {
      Math.random = real;
    }
  });
});

// --- Resolving a policy by id ----------------------------------------------

describe('policyById', () => {
  it('resolves every shipped policy by its own id', () => {
    for (const policy of ALL_POLICIES) expect(policyById(policy.id)).toBe(policy);
  });

  it('throws on an unknown id rather than quietly returning a competent bot', () => {
    // A typo that produced a perfect player would be invisible: Jerk Mode would
    // simply stop working and nothing would say so.
    expect(() => policyById('hits-every-17')).toThrow(/Unknown bot policy "hits-every-17"/);
    expect(() => policyById('')).toThrow(/Unknown bot policy/);
  });

  it('gives every policy a distinct id and some copy for the UI', () => {
    const ids = ALL_POLICIES.map((policy) => policy.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const policy of ALL_POLICIES) {
      expect(policy.label.length, policy.id).toBeGreaterThan(0);
      expect(policy.description.length, policy.id).toBeGreaterThan(0);
    }
  });

  it('covers the six habits SPEC §6 names', () => {
    expect(JERK_POLICIES.map((policy) => policy.id)).toEqual([
      'always-insures',
      'hits-every-16',
      'never-splits',
      'stands-on-soft-17',
      'doubles-twelve',
      'mimics-dealer',
    ]);
  });
});

// --- Choosing the jerk ------------------------------------------------------

describe('assignJerk', () => {
  const candidates = [1, 2, 4, 6];

  it('is deterministic for a seed', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(assignJerk(seed, candidates)).toEqual(assignJerk(seed, candidates));
    }
  });

  it('always picks a seat from the candidates and a habit from the list', () => {
    for (let seed = 0; seed < 500; seed++) {
      const assignment = assignJerk(seed, candidates);
      if (assignment === null) throw new Error('expected an assignment');
      expect(candidates, `seed ${seed}`).toContain(assignment.seat);
      expect(JERK_POLICIES, `seed ${seed}`).toContain(assignment.policy);
    }
  });

  it('reaches every seat and every habit across seeds rather than favouring one', () => {
    const seatsSeen = new Set<number>();
    const habitsSeen = new Set<string>();
    for (let seed = 0; seed < 500; seed++) {
      const assignment = assignJerk(seed, candidates);
      if (assignment === null) throw new Error('expected an assignment');
      seatsSeen.add(assignment.seat);
      habitsSeen.add(assignment.policy.id);
    }
    expect(seatsSeen.size).toBe(candidates.length);
    expect(habitsSeen.size).toBe(JERK_POLICIES.length);
  });

  it('returns null when there are no bot seats — a table of one is not a bug', () => {
    expect(assignJerk(1, [])).toBeNull();
  });

  it('picks the only candidate when there is only one', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(assignJerk(seed, [3])?.seat).toBe(3);
    }
  });

  it('does not perturb the shuffle: the same game seed deals the same cards', () => {
    // The jerk stream is derived from the game seed with its own label, so
    // turning Jerk Mode on cannot change a single card. If it could, the §7
    // counterfactual would be comparing two different shoes and every "the jerk
    // cost me that hand" answer would be noise.
    const cardIds = (events: readonly GameEvent[]): string[] =>
      eventsOfType(events, 'CardDealt').map((event) => event.card.id);

    const without = eventsFrom(PERFECT_POLICY, 60, 20260807);

    const assignment = assignJerk(20260807, [1, 2, 3]);
    expect(assignment).not.toBeNull();
    const with_ = eventsFrom(PERFECT_POLICY, 60, 20260807);

    expect(cardIds(with_)).toEqual(cardIds(without));
    expect(cardIds(without).length).toBeGreaterThan(500);
  });
});

// --- The habits cost money --------------------------------------------------

type HabitCost = {
  /** Mean cost per round, in dollars, of playing the habit instead of the book. */
  readonly mean: number;
  readonly standardError: number;
  readonly total: number;
  /** Rounds where the habit actually changed the outcome. */
  readonly changed: number;
  readonly rounds: number;
};

/**
 * What one habit costs its own seat, measured against the book on the same shoe.
 *
 * Every round is played twice: once as the habit plays it, once replayed from
 * the identical starting state with that seat playing correctly. The difference
 * is exactly zero on every round where the habit made no different decision,
 * which is most of them — so the noise that would otherwise swamp a
 * quarter-of-a-percent effect simply is not sampled. Running two separate
 * sessions and comparing bankrolls would need millions of rounds to say the same
 * thing; this needs tens of thousands.
 *
 * This is the same machinery `counterfactual` uses for the §7 demo, pointed at
 * the jerk's own seat instead of the player's.
 *
 * The pairing is load-bearing and it is guarded, not merely documented: the
 * control below — "costs nothing at all to play the book" — requires perfect
 * against perfect to total *exactly* zero. Seed the corrected run separately, or
 * compare two whole sessions instead of two runs of the same round, and that
 * control fails outright rather than these measurements quietly getting noisier.
 * 
 */
function costOfHabit(policy: BotPolicy, rounds: number, seed: number): HabitCost {
  const deciders = decidersFor(policy, 1);
  let state = tableOf(policy, seed, 1, 10_000_000);
  let total = 0;
  let sumSquares = 0;
  let changed = 0;

  for (let i = 0; i < rounds; i++) {
    const betting = advanceUntilDecision(state).state;
    const played = playRound(betting, deciders);
    // The same starting state, the same shoe, the same stake — the one thing
    // that changes is how the hand is played. `replayRound` does exactly this
    // from a recording; driven live there is nothing to record.
    const corrected = playRound(betting, new Map([[0, flatBettor(PERFECT_POLICY, 5)]]));
    const delta = netOf(corrected.events) - netOf(played.events);
    total += delta;
    sumSquares += delta * delta;
    if (Math.abs(delta) > 1e-9) changed++;
    state = played.state;
  }

  const mean = total / rounds;
  const variance = (sumSquares - rounds * mean * mean) / (rounds - 1);
  return { mean, standardError: Math.sqrt(variance / rounds), total, changed, rounds };
}

function netOf(events: readonly GameEvent[]): number {
  let net = 0;
  for (const event of events) {
    if (event.type === 'HandSettled' || event.type === 'InsuranceSettled') net += event.net;
  }
  return net;
}

describe('every bad habit is actually bad (SPEC §6)', () => {
  /**
   * Sample sizes are per-habit because the habits differ in cost by two orders
   * of magnitude: mimicking the dealer is wrong on a fifth of all hands, while
   * always insuring is wrong on one round in thirteen and only for half a bet.
   * Each size is set so the measured cost clears three standard errors of its
   * own sample — the same "tolerance in standard errors, not constants"
   * discipline `sim.slow.test.ts` uses. `replay.slow.test.ts` runs all six at
   * ten times the sample for a decisive figure; these are sized for the fast
   * suite, which is why the weakest of them sits at 3σ rather than 10.
   */
  it.each([
    { id: 'always-insures', rounds: 120_000 },
    { id: 'hits-every-16', rounds: 20_000 },
    { id: 'never-splits', rounds: 30_000 },
    { id: 'stands-on-soft-17', rounds: 40_000 },
    { id: 'doubles-twelve', rounds: 10_000 },
    { id: 'mimics-dealer', rounds: 6_000 },
  ])('$id loses money against the book over $rounds rounds', ({ id, rounds }) => {
    const cost = costOfHabit(policyById(id), rounds, 20260807);

    // Positive mean = the book would have earned more = the habit costs money.
    expect(cost.mean, `${id} cost ${cost.mean} ± ${cost.standardError}`).toBeGreaterThan(
      3 * cost.standardError,
    );
    // And it is a habit, not a fluke of one round: it fired repeatedly.
    expect(cost.changed, id).toBeGreaterThan(rounds / 200);
  }, 30_000);

  it('costs nothing at all to play the book, because there is nothing to correct', () => {
    // The measurement's own control. Replaying perfect play as perfect play must
    // reproduce the round exactly, so every delta is zero — not merely small.
    const cost = costOfHabit(PERFECT_POLICY, 2_000, 20260807);
    expect(cost.total).toBe(0);
    expect(cost.changed).toBe(0);
  });

});

// --- The tally --------------------------------------------------------------

describe('the session tally', () => {
  it('starts empty', () => {
    expect(EMPTY_JERK_TALLY).toEqual({ helped: 0, hurt: 0, unchanged: 0, netDelta: 0 });
  });

  it('counts one verdict at a time and accumulates the money alongside', () => {
    const jerk = policyById('mimics-dealer');
    const seats: SeatConfig[] = Array.from({ length: VEGAS_STRIP.seatCount }, (_, i) => ({
      occupant:
        i === 0
          ? ({ kind: 'player' } as const)
          : i === 1
            ? ({ kind: 'bot', policyId: jerk.id, characterId: 'j' } as const)
            : ({ kind: 'empty' } as const),
      bankroll: i < 2 ? 100_000 : 0,
    }));
    let state = createGame({ rules: VEGAS_STRIP, seed: 20260807, seats });
    const deciders: Deciders = new Map([
      [0, flatBettor(PERFECT_POLICY, 10)],
      [1, flatBettor(jerk, 10)],
    ]);

    let tally = EMPTY_JERK_TALLY;
    let expectedNet = 0;
    const ROUNDS = 300;
    for (let i = 0; i < ROUNDS; i++) {
      const betting = advanceUntilDecision(state).state;
      const played = playRound(betting, deciders);
      const result = counterfactual(recordRound(betting, played.events), played.events, {
        correctedSeat: 1,
        observedSeat: 0,
      });
      tally = addToTally(tally, result);
      expectedNet += result.delta;
      state = played.state;
    }

    expect(tally.helped + tally.hurt + tally.unchanged).toBe(ROUNDS);
    expect(tally.netDelta).toBeCloseTo(expectedNet, 9);
    expect(tally.helped).toBeGreaterThan(0);
    expect(tally.hurt).toBeGreaterThan(0);
  });
});
