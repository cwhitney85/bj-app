import { describe, it, expect } from 'vitest';

import { mulberry32, restoreRng, deriveSeed, type Rng } from '../src/rng.js';

/** Pull `count` raw floats off a stream. */
function take(rng: Rng, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(rng.next());
  return out;
}

const SEEDS = [0, 1, 2, 7, 42, 1337, 99991, 2 ** 31 - 1, 0xdeadbeef];

describe('mulberry32', () => {
  it('produces values in [0, 1)', () => {
    // Counted rather than asserted per draw: one expect per 5k draws keeps this
    // property test fast while still covering the whole range.
    let outOfRange = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 5000; i++) {
        const v = rng.next();
        if (!(v >= 0 && v < 1)) outOfRange++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    expect(outOfRange).toBe(0);
    expect(min).toBeLessThan(0.01); // the stream should reach both ends of the range
    expect(max).toBeGreaterThan(0.99);
  });

  it('replays an identical sequence for the same seed', () => {
    for (const seed of SEEDS) {
      expect(take(mulberry32(seed), 200)).toEqual(take(mulberry32(seed), 200));
    }
  });

  it('diverges for different seeds', () => {
    // Every distinct pair of seeds must produce a distinct prefix. A shared
    // prefix here would silently collapse "different games" into the same deal.
    for (let a = 0; a < SEEDS.length; a++) {
      for (let b = a + 1; b < SEEDS.length; b++) {
        const left = take(mulberry32(SEEDS[a] as number), 50);
        const right = take(mulberry32(SEEDS[b] as number), 50);
        expect(left).not.toEqual(right);
      }
    }
  });

  it('is not constant — successive draws differ', () => {
    const values = new Set(take(mulberry32(12345), 1000));
    expect(values.size).toBeGreaterThan(990);
  });
});

describe('mulberry32.nextInt', () => {
  it('always lands in [0, n) across many draws and many bounds', () => {
    const bounds = [1, 2, 3, 6, 10, 13, 52, 312, 1000];
    let violations = 0;
    const hitLowest = new Set<number>();
    const hitHighest = new Set<number>();

    for (const bound of bounds) {
      const rng = mulberry32(bound * 7 + 1);
      for (let i = 0; i < 20000; i++) {
        const v = rng.nextInt(bound);
        if (!Number.isInteger(v) || v < 0 || v >= bound) violations++;
        if (v === 0) hitLowest.add(bound);
        if (v === bound - 1) hitHighest.add(bound);
      }
    }

    expect(violations).toBe(0);
    // Both endpoints must be reachable — an off-by-one would silently drop one.
    expect(hitLowest.size).toBe(bounds.length);
    expect(hitHighest.size).toBe(bounds.length);
  });

  it('always returns 0 for a bound of 1', () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 100; i++) expect(rng.nextInt(1)).toBe(0);
  });

  it('rejects non-positive and non-integer bounds', () => {
    const rng = mulberry32(1);
    for (const bad of [0, -1, -10, 1.5, 0.5, -0.5, NaN, Infinity, -Infinity]) {
      expect(() => rng.nextInt(bad)).toThrow(/positive integer/);
    }
  });

  it('does not consume a draw when it rejects a bound', () => {
    const rng = mulberry32(1);
    rng.next();
    const before = rng.drawCount;
    expect(() => rng.nextInt(0)).toThrow();
    expect(rng.drawCount).toBe(before);
  });

  it('spreads nextInt(10) roughly evenly over 100k draws', () => {
    // Crude uniformity smoke test: not a statistical proof, just enough to catch
    // a bucket that is systematically starved or over-fed.
    const draws = 100_000;
    const buckets = new Array<number>(10).fill(0);
    const rng = mulberry32(20240811);
    for (let i = 0; i < draws; i++) {
      const b = rng.nextInt(10);
      buckets[b] = (buckets[b] as number) + 1;
    }

    const expected = draws / 10;
    const tolerance = expected * 0.1; // loose: ±10% of the expected bucket size
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(draws);
    for (const count of buckets) {
      expect(Math.abs(count - expected)).toBeLessThan(tolerance);
    }
  });
});

describe('rng state', () => {
  it('tracks drawCount across next() and nextInt()', () => {
    const rng = mulberry32(77);
    expect(rng.drawCount).toBe(0);
    rng.next();
    expect(rng.drawCount).toBe(1);
    rng.nextInt(10);
    expect(rng.drawCount).toBe(2);
    for (let i = 0; i < 98; i++) rng.next();
    expect(rng.drawCount).toBe(100);
    expect(rng.getState()).toEqual({ seed: 77, drawCount: 100 });
  });

  it('round-trips getState() through restoreRng() from mid-sequence', () => {
    for (const seed of SEEDS) {
      const original = mulberry32(seed);
      take(original, 137); // land somewhere awkward, not on a round boundary
      const state = original.getState();

      const restored = restoreRng(state);
      expect(restored.drawCount).toBe(state.drawCount);
      expect(restored.getState()).toEqual(state);

      // The restored stream must continue identically, not merely start over.
      expect(take(restored, 100)).toEqual(take(original, 100));
    }
  });

  it('a restored stream at drawCount 0 equals a fresh stream', () => {
    const fresh = mulberry32(555);
    const restored = restoreRng({ seed: 555, drawCount: 0 });
    expect(take(restored, 50)).toEqual(take(fresh, 50));
  });

  it('restores repeatedly to the same position (replay is idempotent)', () => {
    const source = mulberry32(31337);
    take(source, 64);
    const state = source.getState();
    const a = take(restoreRng(state), 40);
    const b = take(restoreRng(state), 40);
    const c = take(restoreRng(state), 40);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});

describe('deriveSeed', () => {
  it('is deterministic for the same seed and label', () => {
    for (const seed of SEEDS) {
      for (const label of ['shuffle', 'bots', 'bot:3', '']) {
        expect(deriveSeed(seed, label)).toBe(deriveSeed(seed, label));
      }
    }
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const seed of [...SEEDS, -1, -99999]) {
      const derived = deriveSeed(seed, 'shuffle');
      expect(Number.isInteger(derived)).toBe(true);
      expect(derived).toBeGreaterThanOrEqual(0);
      expect(derived).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('gives different labels different seeds, and therefore different streams', () => {
    const labels = ['shuffle', 'bots', 'bot:0', 'bot:1', 'bot:2', 'jerk', 'dealer'];
    for (const seed of SEEDS) {
      const derived = labels.map((label) => deriveSeed(seed, label));
      expect(new Set(derived).size).toBe(labels.length);

      // Distinct derived seeds must also mean distinct value streams, which is
      // the property bot decisions actually rely on (SPEC §7).
      const streams = derived.map((s) => take(mulberry32(s), 20).join(','));
      expect(new Set(streams).size).toBe(labels.length);
    }
  });

  it('gives different parent seeds different derived seeds for one label', () => {
    const derived = SEEDS.map((seed) => deriveSeed(seed, 'shuffle'));
    expect(new Set(derived).size).toBe(SEEDS.length);
  });

  it('derives a stream independent of the parent stream position', () => {
    // Deriving must not consume from or depend on the parent Rng object at all.
    const parentSeed = 4242;
    const parent = mulberry32(parentSeed);
    take(parent, 500);
    expect(deriveSeed(parentSeed, 'bots')).toBe(deriveSeed(parentSeed, 'bots'));
    expect(parent.drawCount).toBe(500);
  });
});
