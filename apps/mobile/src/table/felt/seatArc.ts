/**
 * Where each chair sits on the felt (SPEC §9).
 *
 * Seven seat positions arced around the dealer, drawn in 2.5D perspective: the
 * chairs in the middle of the table are nearest the viewer and largest, the
 * chairs at either end are further away and smaller.
 *
 * **The table does not rotate, and the player sits in the chair they picked.**
 * SPEC §9 asks for the player's seat to render bottom-centre "for POV
 * consistency"; that is deliberately not done here, on the user's instruction.
 * The reasoning against it is worth keeping, because it is the argument for what
 * replaced it: a blackjack table is a semicircle with the dealer on the flat
 * side, so bottom-centring a corner seat is not a camera move — it is either
 * swinging the dealer off the top of the felt, or renumbering the chairs, which
 * wraps third base around to the player's left where it renders as a seat that
 * acts *before* them. Seat order is not cosmetic (SPEC §4). A fixed table cannot
 * misreport it.
 *
 * What the fixed table costs is SPEC §9's "your cards render larger and nearer",
 * which used to fall out of the geometry when the player was always at the near
 * point. It is now an explicit emphasis the renderer applies to whichever chair
 * the player took — see `Felt.tsx`. Stated rather than dropped: it is a real
 * obligation that moved from this module to that one.
 *
 * There is no game math here. It is a function of the seat count, which is table
 * setup fixed before a card is dealt (shown.ts decision 56).
 */

/**
 * One chair's place on the arc.
 *
 * `x` and `y` are fractions of the felt: `x` runs left to right, `y` runs from
 * the dealer's edge (0) to the near rail (1). `scale` is the perspective
 * multiplier every dimension of the seat is drawn at.
 */
export type SeatPlacement = {
  readonly seat: number;
  /** 0 at the left edge of the arc, 1 at the right. Increases with seat index. */
  readonly x: number;
  /**
   * Where the seat's *near* edge sits: 0 at the dealer, 1 flush with the near
   * rail. The chairs in the middle of the table are nearest.
   *
   * The near edge rather than the centre, because that is the edge the arc is
   * an arc of — anchoring by centre would let the nearest seat hang half off the
   * bottom of the felt and make the renderer invent a correction.
   */
  readonly y: number;
  /** 1 at the near point of the arc, falling to `MIN_SCALE` at either end. */
  readonly scale: number;
};

/** How wide the arc spreads. Leaves a margin so the outermost seat is not clipped. */
const HALF_WIDTH = 0.42;

/**
 * The end seats are this fraction of the near seats' size.
 *
 * Floored by legibility rather than chosen for the look: at 0.58 a card at first
 * base was 14px wide and its rank could not be read, which makes the felt unable
 * to show the thing SPEC §7 is an argument about — what the player at the other
 * end of the table is actually doing.
 */
const MIN_SCALE = 0.7;

/** How much of the felt's height the arc sweeps through. */
const ARC_DEPTH = 0.5;

/**
 * Lay out every chair at the table.
 *
 * Precondition (a caller bug, and thrown): `seatCount >= 1`.
 *
 * Postconditions, all asserted in `test/seatArc.test.ts`:
 * - one placement per seat, in seat order;
 * - `x` is strictly increasing, so the drawn left-to-right order *is* the turn
 *   order — this is the property the module exists for;
 * - the arc is symmetric: seat `s` and seat `seatCount - 1 - s` are mirror
 *   images in `x`, and identical in `y` and `scale`;
 * - the end seats are the furthest and the smallest;
 * - every `x` and `y` lands in [0, 1] and every `scale` in (0, 1].
 *
 * Every seat is placed, occupied or not. The arc is a property of the table
 * rather than of who showed up, so a bot joining or the felt clearing never
 * moves a chair that was already on screen.
 */
export function seatArc(seatCount: number): readonly SeatPlacement[] {
  if (seatCount < 1) throw new Error(`seatArc: a table has at least one seat, got ${seatCount}`);

  return Array.from({ length: seatCount }, (_, seat): SeatPlacement => {
    // `t` is the normalised sweep: -1 at the far left of the arc, +1 at the far
    // right, 0 at the near point. A one-seat table has no sweep and sits at the
    // near point, which is also what guards the division.
    const t = seatCount === 1 ? 0 : (2 * seat) / (seatCount - 1) - 1;

    // A parabola in `t`, which reads as the near edge of an ellipse: deepest
    // (nearest the viewer, largest) in the middle and rising away on both sides.
    const nearness = 1 - t * t;

    return {
      seat,
      x: 0.5 + t * HALF_WIDTH,
      y: 1 - ARC_DEPTH * (1 - nearness),
      scale: MIN_SCALE + (1 - MIN_SCALE) * nearness,
    };
  });
}

/**
 * What to call a seat.
 *
 * "First base" and "third base" are the names SPEC §7's whole argument is
 * conducted in, so the felt uses them rather than leaving the player to count
 * chairs. They are absolute positions at the table, not relative ones: first
 * base acts first and third base acts last, whoever the player is — which is
 * exactly why they survive the table no longer rotating.
 *
 * Seats are numbered from 1 here and 0 in the engine. Every other screen in the
 * app already labels them `seat + 1` (`SeatSelectScreen`, `JerkPicker`); the old
 * table screen was the one place printing the raw index, so the picker read
 * "Seat 5" for the chair the felt called "Seat 4".
 */
export function seatName(seat: number, seatCount: number, isPlayer: boolean): string {
  if (isPlayer) return 'You';
  if (seat === 0) return 'First base';
  if (seat === seatCount - 1) return 'Third base';
  return `Seat ${seat + 1}`;
}
