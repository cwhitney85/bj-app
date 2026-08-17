/**
 * The arc's contract (SPEC §9, and SPEC §4's "seat order is not cosmetic").
 *
 * The load-bearing property is the third block: **drawn left-to-right order is
 * turn order.** Everything else here is a range check. That one is the reason
 * the module exists, and it is the property the rejected alternative — rotating
 * the seat indices modulo the seat count so the player lands bottom-centre —
 * fails silently: the felt would look right, and third base would be drawn to
 * the left of a player at first base, i.e. drawn as a seat that acts before
 * them. Nothing else in the app could notice.
 */

import { describe, expect, it } from 'vitest';

import { seatArc, seatName } from '../src/table/felt/seatArc';

const SEATS = 7;

describe('seatArc', () => {
  it('places every seat, in seat order', () => {
    const arc = seatArc(SEATS);
    expect(arc).toHaveLength(SEATS);
    expect(arc.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('refuses a table with no seats', () => {
    expect(() => seatArc(0)).toThrow(/at least one seat/);
    expect(() => seatArc(-1)).toThrow(/at least one seat/);
  });

  // --- The property the module exists for ---------------------------------

  it('draws left to right in turn order, for every table size', () => {
    for (let count = 1; count <= 9; count++) {
      const xs = seatArc(count).map((p) => p.x);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i]!, `seat ${i} of ${count} must draw right of seat ${i - 1}`).toBeGreaterThan(
          xs[i - 1]!,
        );
      }
    }
  });

  it('is symmetric, so first base and third base are equally prominent', () => {
    const arc = seatArc(SEATS);
    for (let seat = 0; seat < SEATS; seat++) {
      const mirror = arc[SEATS - 1 - seat]!;
      const here = arc[seat]!;
      expect(here.x + mirror.x).toBeCloseTo(1, 10);
      expect(here.y).toBeCloseTo(mirror.y, 10);
      expect(here.scale).toBeCloseTo(mirror.scale, 10);
    }
  });

  // --- Perspective ---------------------------------------------------------

  it('makes the end seats the furthest and the smallest', () => {
    const arc = seatArc(SEATS);
    const ends = [arc[0]!, arc[SEATS - 1]!];
    const middle = arc[3]!;

    for (const end of ends) {
      expect(end.y).toBeLessThan(middle.y); // further from the near rail
      expect(end.scale).toBeLessThan(middle.scale);
    }
    // The near point is the largest thing on the arc, at full size.
    expect(middle.scale).toBeCloseTo(1, 10);
    expect(middle.y).toBeCloseTo(1, 10);
  });

  it('keeps every placement on the felt', () => {
    for (let count = 1; count <= 9; count++) {
      for (const placement of seatArc(count)) {
        expect(placement.x).toBeGreaterThanOrEqual(0);
        expect(placement.x).toBeLessThanOrEqual(1);
        expect(placement.y).toBeGreaterThanOrEqual(0);
        expect(placement.y).toBeLessThanOrEqual(1);
        expect(placement.scale).toBeGreaterThan(0);
        expect(placement.scale).toBeLessThanOrEqual(1);
      }
    }
  });

  it('places a one-seat table at the near point rather than dividing by zero', () => {
    const [only] = seatArc(1);
    expect(only).toEqual({ seat: 0, x: 0.5, y: 1, scale: 1 });
  });

  it('does not move a chair when the player changes seat', () => {
    // The whole point of a fixed table: the geometry is a function of the table,
    // not of who sat down. Nothing here takes a player seat at all, and this
    // test is what stops one being threaded back in without a reason.
    expect(seatArc(SEATS)).toEqual(seatArc(SEATS));
  });
});

describe('seatName', () => {
  it('names the two seats SPEC §7 argues about', () => {
    expect(seatName(0, SEATS, false)).toBe('First base');
    expect(seatName(SEATS - 1, SEATS, false)).toBe('Third base');
  });

  it('numbers the rest from one, like every other screen', () => {
    // `SeatSelectScreen` and `JerkPicker` both print `seat + 1`. The old table
    // screen printed the raw index, so the picker said "Seat 5" for the chair
    // the felt called "Seat 4".
    expect(seatName(3, SEATS, false)).toBe('Seat 4');
  });

  it('calls the player themselves, wherever they are sitting', () => {
    expect(seatName(0, SEATS, true)).toBe('You');
    expect(seatName(SEATS - 1, SEATS, true)).toBe('You');
    expect(seatName(3, SEATS, true)).toBe('You');
  });
});
