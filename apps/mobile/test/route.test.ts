/**
 * The shell's pure half: how a `SeatDraft` becomes a table, and how the four
 * routes connect.
 *
 * The draft is now a *set of chairs the player picked*, not a count plus a rule
 * for placing them, so there is no seating algorithm left to test. What is worth
 * asserting is what the draft type promises and cannot express:
 *
 * 1. **`botSeats` never contains `playerSeat`.** Two occupants in one chair
 *    resolves silently in `seating`, which prefers the player — so the screen
 *    would show a bot the dealt table does not have.
 * 2. **Every draft the screen can build deals a table the engine accepts.**
 *    `configFrom` feeds `openTableState` directly and is its only input.
 * 3. **`DEFAULT_CONFIG` still describes the shipping table.** It is the fixture
 *    `tableState.test.ts` and `jerk.test.ts` drive; if seat select deals
 *    something structurally different, those suites test a table nobody plays.
 */

import { describe, expect, it } from 'vitest';

import {
  canDeal,
  configFrom,
  EMPTY_DRAFT,
  isSeat,
  MAX_BOTS,
  SEAT_COUNT,
  sitAt,
  standUp,
  toggleBot,
  type SeatDraft,
} from '../src/seat/seatDraft';
import { dealt, dealtAgain, finished, HOME, SEAT_SELECT } from '../src/shell/route';
import {
  DEFAULT_CONFIG,
  openingDeciders,
  openTableState,
  seating,
  tally,
} from '../src/table/tableState';

const SEED = 20260816;

/** Every chair, seated, with every subset size of bots filled around it. */
function everyDraft(): SeatDraft[] {
  const drafts: SeatDraft[] = [];
  for (let playerSeat = 0; playerSeat < SEAT_COUNT; playerSeat += 1) {
    const others = Array.from({ length: SEAT_COUNT }, (_, i) => i).filter(
      (i) => i !== playerSeat,
    );
    for (let take = 0; take <= MAX_BOTS; take += 1) {
      drafts.push(
        others.slice(0, take).reduce(toggleBot, sitAt(EMPTY_DRAFT, playerSeat)),
      );
    }
  }
  return drafts;
}

describe('laying out the table', () => {
  it('starts with nobody seated and nothing dealable', () => {
    expect(EMPTY_DRAFT.playerSeat).toBeNull();
    expect(EMPTY_DRAFT.botSeats).toEqual([]);
    expect(canDeal(EMPTY_DRAFT)).toBe(false);
    expect(canDeal(sitAt(EMPTY_DRAFT, 3))).toBe(true);
  });

  it('never seats a bot in the player’s chair, however the two are ordered', () => {
    // Bot first, then the player sits on top of it.
    const botThenPlayer = sitAt(toggleBot(sitAt(EMPTY_DRAFT, 0), 4), 4);
    expect(botThenPlayer.playerSeat).toBe(4);
    expect(botThenPlayer.botSeats).not.toContain(4);

    // And the other order is refused outright rather than resolved.
    expect(() => toggleBot(sitAt(EMPTY_DRAFT, 4), 4)).toThrow();
  });

  it('toggles a chair on and off, keeping seating-chart order', () => {
    let draft = sitAt(EMPTY_DRAFT, 3);
    draft = toggleBot(draft, 5);
    draft = toggleBot(draft, 1);
    draft = toggleBot(draft, 4);
    expect(draft.botSeats).toEqual([1, 4, 5]);

    draft = toggleBot(draft, 4);
    expect(draft.botSeats).toEqual([1, 5]);
  });

  it('leaves the bots alone when the player stands up', () => {
    const seated = toggleBot(toggleBot(sitAt(EMPTY_DRAFT, 3), 1), 5);
    const standing = standUp(seated);
    expect(standing.playerSeat).toBeNull();
    expect(standing.botSeats).toEqual([1, 5]);
    expect(canDeal(standing)).toBe(false);
  });

  it('rejects a chair that does not exist — that is a caller bug', () => {
    expect(isSeat(-1)).toBe(false);
    expect(isSeat(SEAT_COUNT)).toBe(false);
    expect(isSeat(1.5)).toBe(false);
    expect(() => sitAt(EMPTY_DRAFT, SEAT_COUNT)).toThrow();
    expect(() => toggleBot(sitAt(EMPTY_DRAFT, 0), -1)).toThrow();
  });
});

describe('configFrom', () => {
  it('refuses to deal a table the player is not at', () => {
    expect(() => configFrom(EMPTY_DRAFT, SEED)).toThrow();
  });

  it('deals a table the engine accepts, for every draft the screen can build', () => {
    for (const draft of everyDraft()) {
      const config = configFrom(draft, SEED);
      const state = openTableState(config, openingDeciders(config));

      const chart = seating(config);
      expect(chart).toHaveLength(SEAT_COUNT);
      expect(chart[config.playerSeat]?.occupant.kind).toBe('player');
      for (const seat of config.botSeats) {
        expect(chart[seat]?.occupant.kind).toBe('bot');
      }
      expect(state.felt.seats).toHaveLength(SEAT_COUNT);
      expect(state.jerkStraddled).toBe(false);
    }
  });

  it('seats a bad player whenever there is a bot to be one, and never otherwise', () => {
    for (const draft of everyDraft()) {
      const config = configFrom(draft, SEED);
      const state = openTableState(config, openingDeciders(config));
      if (config.botSeats.length === 0) {
        expect(config.startWithJerk).toBe(false);
        expect(state.jerk).toBeNull();
      } else {
        // PLAN decision 76: a table deals with the demo already running,
        // because shipping it off and undiscovered is worse.
        expect(config.startWithJerk).toBe(true);
        expect(config.botSeats).toContain(state.jerk?.seat);
      }
    }
  });

  it('carries the seed through, so a session is reproducible from its config', () => {
    expect(configFrom(sitAt(EMPTY_DRAFT, 3), SEED).seed).toBe(SEED);
  });
});

/**
 * `DEFAULT_CONFIG` is the fixture the other two suites drive. This pins it to
 * the production path, so it cannot drift into describing a table the seat
 * screen can no longer lay out.
 */
describe('DEFAULT_CONFIG', () => {
  it('is what seat select deals from the equivalent draft', () => {
    const draft = [2, 4].reduce(toggleBot, sitAt(EMPTY_DRAFT, 3));
    expect(configFrom(draft, DEFAULT_CONFIG.seed)).toEqual(DEFAULT_CONFIG);
  });
});

describe('routes', () => {
  it('deals a table whose config came from the draft', () => {
    const draft = toggleBot(sitAt(EMPTY_DRAFT, 3), 4);
    const route = dealt(draft, SEED);
    expect(route.screen).toBe('table');
    if (route.screen !== 'table') throw new Error('unreachable');
    expect(route.config).toEqual(configFrom(draft, SEED));
  });

  it('carries the report and the table it was about to the report screen', () => {
    const config = configFrom(toggleBot(sitAt(EMPTY_DRAFT, 3), 4), SEED);
    const report = tally(openTableState(config, openingDeciders(config)));
    const route = finished(config, report);

    expect(route.screen).toBe('report');
    if (route.screen !== 'report') throw new Error('unreachable');
    expect(route.report).toBe(report);
    expect(route.config).toBe(config);
  });

  /**
   * "Play again" must be a new session, not a replay. Same seating and a
   * different shoe: reusing the seed would deal the identical hands, which is a
   * debugging tool and not what the button says.
   */
  it('plays again with the same seating and a fresh shoe', () => {
    const config = configFrom(toggleBot(sitAt(EMPTY_DRAFT, 3), 4), SEED);
    const route = dealtAgain(config, SEED + 1);

    expect(route.screen).toBe('table');
    if (route.screen !== 'table') throw new Error('unreachable');
    expect(route.config.seed).not.toBe(config.seed);
    expect(route.config.playerSeat).toBe(config.playerSeat);
    expect(route.config.botSeats).toEqual(config.botSeats);
  });

  it('has two constant screens with nothing to carry', () => {
    expect(HOME.screen).toBe('home');
    expect(SEAT_SELECT.screen).toBe('seat-select');
  });
});
