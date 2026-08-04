/**
 * Seeded PRNG. The whole engine's determinism rests on this file: given a seed,
 * every shuffle, every bot decision, and therefore every round must replay
 * identically. That property is what makes the third-base counterfactual demo
 * (SPEC §7) possible at all.
 */

export type Rng = {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** How many values have been drawn. Part of the serialisable state. */
  readonly drawCount: number;
  /** Snapshot sufficient to resume this exact stream. */
  getState(): RngState;
};

export type RngState = {
  readonly seed: number;
  readonly drawCount: number;
};

/** Mulberry32: 32-bit state, fast, good enough distribution for card dealing. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  let draws = 0;

  const next = (): number => {
    draws++;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    nextInt(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error(`nextInt requires a positive integer bound, got ${maxExclusive}`);
      }
      return Math.floor(next() * maxExclusive);
    },
    get drawCount() {
      return draws;
    },
    getState() {
      return { seed, drawCount: draws };
    },
  };
}

/**
 * Rebuild an Rng and fast-forward it to a previous position. Used by replay:
 * restoring a seed alone is not enough, the stream position matters too.
 */
export function restoreRng(state: RngState): Rng {
  const rng = mulberry32(state.seed);
  for (let i = 0; i < state.drawCount; i++) rng.next();
  return rng;
}

/**
 * Derive an independent stream from a parent seed. Lets bot decisions draw
 * without perturbing the shuffle stream, so changing bot behaviour in a
 * counterfactual replay cannot change which cards come out of the shoe.
 */
export function deriveSeed(seed: number, label: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}
